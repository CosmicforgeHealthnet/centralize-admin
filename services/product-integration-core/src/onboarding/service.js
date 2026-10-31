"use strict";

// Universal Product Admin onboarding workflow. Every step is explicitly
// authorized, revision-checked, recorded in the append-only approval history
// and audited in the same transaction. Product-neutral: there is no branch on
// product_id anywhere in this module.

const { randomUUID } = require("node:crypto");
const C = require("../../../../packages/admin-contracts");
const I = require("../../../../packages/identity-and-permissions");
const { T, withTx } = require("../db");
const { recordAudit } = require("../audit");
const { authorizeStaff } = require("../authz");
const { resolveEndpoint, clientFor, EndpointError } = require("../registry/endpoints");
const SM = require("./state-machine");
const policy = require("../registry/sync-policy");

class OnboardingError extends Error {
  constructor(reason, status = 409, detail) {
    super(reason);
    this.name = "OnboardingError";
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

const REASON = new RegExp(C.PATTERNS.code);
const EVIDENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/;
const DIMS = ["market", "organization", "zone", "tenant"];
const SCOPE_VALUE = new RegExp(C.PATTERNS.scopeValue);
const SETTABLE = new Set(["identity_verified_at", "manifest_digest", "manifest_revision", "manifest_expires_at", "health_status", "health_checked_at", "sync_status", "drift_status", "drift_detected_at", "current_contract_id", "activated_at", "activated_by", "suspended_at", "suspended_by", "suspension_reason", "revoked_at", "revoked_by", "revocation_reason"]);

function validScope(scope, { allowedDims = DIMS, required = [] } = {}) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  for (const [dim, values] of Object.entries(scope)) {
    if (!allowedDims.includes(dim) || !Array.isArray(values) || values.length === 0 || values.length > 64) return false;
    if (values.some((v) => typeof v !== "string" || !SCOPE_VALUE.test(v) || v === "*")) return false;
    if (new Set(values).size !== values.length) return false;
  }
  return required.every((dim) => Array.isArray(scope[dim]));
}

function subsetScope(inner, outer) {
  for (const [dim, values] of Object.entries(inner)) {
    if (outer[dim] && values.some((v) => !outer[dim].includes(v))) return false;
  }
  return true;
}

function createOnboarding({ pool, endpoints, trustStore, environment, now = Date.now, clientOptions = {} }) {
  const authz = (subject, action, ctx, extra = {}) => authorizeStaff(pool, { subject, action, correlationId: ctx.correlationId, now: now(), ...extra });

  async function lockRow(client, id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new OnboardingError("NOT_FOUND", 404);
    const { rows } = await client.query(`SELECT * FROM ${T}hq_product_admins WHERE id = $1 AND environment = $2 FOR UPDATE`, [id, environment]);
    if (!rows[0]) throw new OnboardingError("NOT_FOUND", 404);
    return rows[0];
  }

  async function getRow(id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new OnboardingError("NOT_FOUND", 404);
    const { rows } = await pool.query(`SELECT * FROM ${T}hq_product_admins WHERE id = $1 AND environment = $2`, [id, environment]);
    if (!rows[0]) throw new OnboardingError("NOT_FOUND", 404);
    return rows[0];
  }

  async function approval(client, row, fields, ctx) {
    await client.query(
      `INSERT INTO ${T}hq_product_admin_onboarding_approvals (product_admin_id, decision, from_status, to_status, actor_id, reason_code, evidence_ref, expected_revision, resulting_revision, contract_id, dataset_row_id, subscription_id, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [row.id, fields.decision, fields.from || null, fields.to || null, fields.actorId, fields.reasonCode || null, fields.evidenceRef || null, fields.expectedRevision ?? null, fields.resultingRevision ?? null, fields.contractId || null, fields.datasetRowId || null, fields.subscriptionId || null, ctx.correlationId || null]);
  }

  async function audit(client, subject, row, action, ctx, metadata = {}, outcome = "RECORDED", reasonCode = null) {
    await recordAudit(client, { correlationId: ctx.correlationId, actorType: "STAFF", actorId: subject.staffId, productId: row ? row.product_id : null, productAdminId: row ? row.id : null, action, outcome, reasonCode, metadata });
  }

  async function transition(client, row, to, subject, opts, ctx) {
    SM.assertTransition({ from: row.lifecycle_status, to, actorId: subject.staffId, requestedBy: row.requested_by, certifiedBy: opts.certifiedBy || null, expectedRevision: opts.expectedRevision, currentRevision: row.revision, reviewedFromSuspension: Boolean(opts.reviewedFromSuspension) });
    const set = opts.set || {};
    const keys = Object.keys(set);
    for (const key of keys) if (!SETTABLE.has(key)) throw new Error("column_not_settable:" + key);
    const assignments = keys.map((key, i) => `${key} = $${i + 5}`);
    const { rows } = await client.query(
      `UPDATE ${T}hq_product_admins SET lifecycle_status = $1, revision = revision + 1${assignments.length ? ", " + assignments.join(", ") : ""}
       WHERE id = $2 AND revision = $3 AND lifecycle_status = $4 RETURNING *`,
      [to, row.id, opts.expectedRevision, row.lifecycle_status, ...keys.map((k) => set[k])]);
    if (!rows[0]) throw new SM.TransitionError("STALE_REVISION");
    await approval(client, row, { decision: "TRANSITION", from: row.lifecycle_status, to, actorId: subject.staffId, reasonCode: opts.reasonCode, evidenceRef: opts.evidenceRef, expectedRevision: opts.expectedRevision, resultingRevision: rows[0].revision, contractId: opts.contractId }, ctx);
    await audit(client, subject, row, "integration.transition", ctx, { from_status: row.lifecycle_status, to_status: to, revision: rows[0].revision });
    return rows[0];
  }

  // Fetches and verifies the manifest from the registry-pinned destination.
  async function fetchVerifiedManifest(row, { minimumRevision } = {}) {
    // Never verify against a trust store whose source files changed after it
    // was loaded (e.g. a revocation written by an operator): restart first.
    if (trustStore && typeof trustStore.isCurrent === "function" && !trustStore.isCurrent()) throw new OnboardingError("TRUST_STORE_CHANGED", 503);
    let endpoint;
    try { endpoint = resolveEndpoint(endpoints, row); } catch (err) { throw new OnboardingError(err.reason || "ENDPOINT_INVALID", 409); }
    if (endpoint.fingerprint256 || row.identity_fingerprint_ref) {
      if (!endpoint.fingerprint256 || row.identity_fingerprint_ref !== "sha256:" + endpoint.fingerprint256) throw new OnboardingError("IDENTITY_FINGERPRINT_MISMATCH", 409);
    }
    let response;
    try {
      response = await clientFor(endpoints, row, clientOptions).getManifest();
    } catch (err) {
      throw new OnboardingError("PRODUCT_ADMIN_UNREACHABLE", 503, err.code);
    }
    if (response.status !== 200 || !response.json.result) throw new OnboardingError("MANIFEST_UNAVAILABLE", 503, response.json.error && response.json.error.reason);
    try {
      return C.verifyManifest(response.json.result, {
        trustStore, now: now(),
        expected: { productId: row.product_id, serviceInstanceId: row.service_instance_id, environment: row.environment, workloadIdentity: row.workload_identity, signerKid: row.approved_signer_kid, minimumRevision },
      });
    } catch (err) {
      throw new OnboardingError(err.reason || "MANIFEST_INVALID", 422, err.detail);
    }
  }

  async function recordFailure(row, subject, reason, ctx) {
    await withTx(pool, async (client) => {
      await approval(client, row, { decision: "IDENTITY_CHECK_FAILED", actorId: subject.staffId, reasonCode: REASON.test(reason) ? reason : "IDENTITY_CHECK_FAILED" }, ctx);
      await audit(client, subject, row, "integration.verify", ctx, {}, "DENIED", REASON.test(reason) ? reason : null);
    });
  }

  async function candidateContract(client, productAdminId) {
    const { rows } = await client.query(
      `SELECT c.* FROM ${T}hq_product_admin_onboarding_approvals a JOIN ${T}hq_product_admin_contracts c ON c.id = a.contract_id
       WHERE a.product_admin_id = $1 AND a.decision = 'CONTRACT_VALIDATED' ORDER BY a.id DESC LIMIT 1`, [productAdminId]);
    return rows[0] || null;
  }

  // While an ENABLED product has any unresolved drift, nothing new may be
  // activated for it (dataset approval, subscription creation or enabling):
  // the drift must first be resolved by re-verification or a reviewed
  // contract activation.
  function assertNoUnresolvedDrift(row) {
    if (row.lifecycle_status !== "ENABLED") return;
    const blocked = policy.driftBlock(row.drift_status);
    if (blocked) throw new OnboardingError("CONTRACT_DRIFT_UNRESOLVED", 409, blocked);
  }

  // A dataset version may be approved or subscribed only if the contract in
  // force declares exactly that version and schema: the active contract once
  // ENABLED, the validated onboarding candidate before that.
  async function assertDeclaredByCurrentContract(client, row, ds) {
    let current = null;
    if (row.lifecycle_status === "ENABLED") ({ rows: [current] } = await client.query(`SELECT catalog FROM ${T}hq_product_admin_contracts WHERE id = $1 AND status = 'ACTIVE'`, [row.current_contract_id]));
    else current = await candidateContract(client, row.id);
    const declared = current && (current.catalog.datasets || []).find((d) => d.dataset_id === ds.dataset_id && d.version === ds.version);
    if (!declared || declared.schema_digest !== ds.schema_digest) throw new OnboardingError("DATASET_NOT_IN_CURRENT_CONTRACT", 409);
  }

  async function activeContract(client, productAdminId) {
    const { rows } = await client.query(`SELECT * FROM ${T}hq_product_admin_contracts WHERE product_admin_id = $1 AND status = 'ACTIVE'`, [productAdminId]);
    return rows[0] || null;
  }

  async function approvedDatasetCount(client, productAdminId) {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${T}hq_product_admin_datasets WHERE product_admin_id = $1 AND approval_status = 'APPROVED'`, [productAdminId]);
    return rows[0].n;
  }

  function catalogOf(manifest) {
    return { product_id: manifest.product_id, protocol: manifest.protocol, capabilities: manifest.capabilities, datasets: manifest.datasets, event_families: manifest.event_families };
  }

  async function insertContract(client, row, verified, { status, compatibility, validatedBy }) {
    const { rows: [{ next }] } = await client.query(`SELECT COALESCE(max(revision), 0) + 1 AS next FROM ${T}hq_product_admin_contracts WHERE product_admin_id = $1`, [row.id]);
    const id = randomUUID();
    const m = verified.manifest;
    await client.query(
      `INSERT INTO ${T}hq_product_admin_contracts (id, product_admin_id, revision, protocol_major, protocol_minor, manifest_revision, manifest_digest, catalog_digest, build_sha, catalog, compatibility, status, validated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, row.id, next, m.protocol.major, m.protocol.minor, m.manifest_revision, verified.manifestDigest, verified.catalogDigest, m.build_sha, JSON.stringify(catalogOf(m)), JSON.stringify(compatibility), status, validatedBy]);
    if (status === "VALIDATED") {
      for (const ds of m.datasets) {
        await client.query(
          `INSERT INTO ${T}hq_product_admin_datasets (id, product_admin_id, contract_id, dataset_id, version, schema_id, schema_digest, privacy_class, scope_dimensions, authorized_departments, semantic_grain, units, currency, freshness_target_seconds, lineage, allowed_fields, metrics, retention_days, approval_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'PROPOSED') ON CONFLICT (product_admin_id, dataset_id, version) DO NOTHING`,
          [randomUUID(), row.id, id, ds.dataset_id, ds.version, ds.schema_id, ds.schema_digest, ds.privacy_class, ds.scope_dimensions, ds.authorized_departments, ds.semantic_grain, ds.units, ds.currency, ds.freshness_target_seconds, JSON.stringify(ds.lineage), JSON.stringify(ds.allowed_fields), JSON.stringify(ds.metrics), ds.retention_days]);
        const { rows: existing } = await client.query(`SELECT schema_digest FROM ${T}hq_product_admin_datasets WHERE product_admin_id = $1 AND dataset_id = $2 AND version = $3`, [row.id, ds.dataset_id, ds.version]);
        if (existing[0].schema_digest !== ds.schema_digest) throw new OnboardingError("SILENT_DATASET_CHANGE", 409);
      }
    }
    return { id, revision: next };
  }

  return {
    async list(subject, ctx) {
      await authz(subject, "integration.read", ctx);
      const { rows } = await pool.query(`SELECT * FROM ${T}hq_product_admins WHERE environment = $1 ORDER BY product_id, created_at`, [environment]);
      return rows;
    },

    async get(subject, id, ctx) {
      await authz(subject, "integration.read", ctx);
      const row = await getRow(id);
      const [contracts, datasets, subscriptions, history] = await Promise.all([
        pool.query(`SELECT id, revision, status, manifest_revision, manifest_digest, catalog_digest, build_sha, compatibility, validated_by, validated_at, certified_by, certified_at, certification_evidence_ref, activated_at FROM ${T}hq_product_admin_contracts WHERE product_admin_id = $1 ORDER BY revision`, [id]),
        pool.query(`SELECT id, dataset_id, version, privacy_class, approval_status, approved_by, approved_at, authorized_departments, scope_dimensions FROM ${T}hq_product_admin_datasets WHERE product_admin_id = $1 ORDER BY dataset_id, version`, [id]),
        pool.query(`SELECT id, dataset_row_id, consumer_department, enabled, status, coverage, gap_status, quarantined_count, last_success_at, last_source_observation_at FROM ${T}hq_product_admin_subscriptions WHERE product_admin_id = $1`, [id]),
        pool.query(`SELECT id, decision, from_status, to_status, actor_id, reason_code, evidence_ref, expected_revision, resulting_revision, contract_id, created_at FROM ${T}hq_product_admin_onboarding_approvals WHERE product_admin_id = $1 ORDER BY id`, [id]),
      ]);
      return { registration: row, contracts: contracts.rows, datasets: datasets.rows, subscriptions: subscriptions.rows, history: history.rows };
    },

    // Registers a product as UNTRUSTED (DRAFT -> REQUESTED). Nothing about the
    // product is trusted until each gate below passes.
    async request(subject, input, ctx) {
      await authz(subject, "integration.request", ctx);
      const fields = ["product_id", "display_name", "service_instance_id", "environment", "endpoint_ref", "workload_identity", "approved_signer_kid", "identity_fingerprint_ref", "allowed_scope"];
      for (const key of Object.keys(input || {})) if (!fields.includes(key)) throw new OnboardingError("UNKNOWN_FIELD", 400);
      const p = C.PATTERNS;
      if (!new RegExp(p.productId).test(String(input.product_id)) || !new RegExp(p.serviceInstanceId).test(String(input.service_instance_id)) ||
          !new RegExp(p.workloadIdentity).test(String(input.workload_identity)) || !new RegExp(p.keyId).test(String(input.approved_signer_kid)) ||
          typeof input.display_name !== "string" || input.display_name.length < 1 || input.display_name.length > 64 ||
          (input.identity_fingerprint_ref !== undefined && input.identity_fingerprint_ref !== null && !/^sha256:[0-9a-f]{64}$/.test(String(input.identity_fingerprint_ref)))) {
        throw new OnboardingError("INVALID_REGISTRATION", 400);
      }
      if (input.environment !== environment) throw new OnboardingError("ENVIRONMENT_ISOLATION", 403);
      if (!validScope(input.allowed_scope || {}, { required: ["market", "organization"] })) throw new OnboardingError("ALLOWED_SCOPE_INVALID", 400);
      const endpoint = endpoints.get(input.endpoint_ref);
      if (!endpoint) throw new OnboardingError("ENDPOINT_NOT_ALLOWLISTED", 400);
      if (endpoint.productId !== input.product_id || endpoint.environment !== environment) throw new OnboardingError("ENDPOINT_PRODUCT_MISMATCH", 403);
      if (trustStore && typeof trustStore.isCurrent === "function" && !trustStore.isCurrent()) throw new OnboardingError("TRUST_STORE_CHANGED", 503);
      const signer = trustStore && Object.prototype.hasOwnProperty.call(trustStore, input.approved_signer_kid) ? trustStore[input.approved_signer_kid] : null;
      if (!signer || signer.productId !== input.product_id || signer.environment !== environment) throw new OnboardingError("SIGNER_NOT_ENROLLED", 400);
      if (policy.signerBlock({ approved_signer_kid: input.approved_signer_kid, product_id: input.product_id, environment }, trustStore, now())) throw new OnboardingError("SIGNER_NOT_CURRENT", 400);
      const id = randomUUID();
      try {
        return await withTx(pool, async (client) => {
          const { rows } = await client.query(
            `INSERT INTO ${T}hq_product_admins (id, product_id, display_name, service_instance_id, environment, endpoint_ref, workload_identity, identity_fingerprint_ref, approved_signer_kid, allowed_scope, lifecycle_status, requested_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11) RETURNING *`,
            [id, input.product_id, input.display_name, input.service_instance_id, environment, input.endpoint_ref, input.workload_identity, input.identity_fingerprint_ref || null, input.approved_signer_kid, JSON.stringify(input.allowed_scope), subject.staffId]);
          await approval(client, rows[0], { decision: "TRANSITION", from: null, to: "DRAFT", actorId: subject.staffId, resultingRevision: 1 }, ctx);
          return transition(client, rows[0], "REQUESTED", subject, { expectedRevision: 1 }, ctx);
        });
      } catch (err) {
        if (err.code === "23505") throw new OnboardingError("ALREADY_REGISTERED", 409);
        throw err;
      }
    },

    async verifyIdentity(subject, id, { expected_revision } = {}, ctx) {
      await authz(subject, "integration.verify", ctx);
      const row = await getRow(id);
      if (row.lifecycle_status !== "REQUESTED") throw new SM.TransitionError("TRANSITION_NOT_ALLOWED");
      let verified;
      try { verified = await fetchVerifiedManifest(row); } catch (err) { await recordFailure(row, subject, err.reason, ctx); throw err; }
      return withTx(pool, async (client) => {
        const locked = await lockRow(client, id);
        return transition(client, locked, "IDENTITY_VERIFIED", subject, {
          expectedRevision: expected_revision,
          set: { identity_verified_at: new Date(now()), manifest_digest: verified.manifestDigest, manifest_revision: verified.manifest.manifest_revision, manifest_expires_at: verified.expiresAt, health_status: "REACHABLE", health_checked_at: new Date(now()), drift_status: "NONE" },
        }, ctx);
      });
    },

    async validateContract(subject, id, { expected_revision } = {}, ctx) {
      await authz(subject, "integration.verify", ctx);
      const row = await getRow(id);
      if (row.lifecycle_status !== "IDENTITY_VERIFIED") throw new SM.TransitionError("TRANSITION_NOT_ALLOWED");
      let verified;
      try { verified = await fetchVerifiedManifest(row, { minimumRevision: row.manifest_revision }); } catch (err) { await recordFailure(row, subject, err.reason, ctx); throw err; }
      return withTx(pool, async (client) => {
        const locked = await lockRow(client, id);
        if (locked.revision !== expected_revision) throw new SM.TransitionError("STALE_REVISION");
        const active = await activeContract(client, id);
        const proposed = catalogOf(verified.manifest);
        let contractId;
        if (active && active.catalog_digest === verified.catalogDigest) {
          contractId = active.id; // unchanged catalog after re-review: keep the pinned contract
        } else {
          const comparison = active ? C.compareCatalogs(active.catalog, proposed) : { decision: "INITIAL", changes: [] };
          if (comparison.decision === "BREAKING") {
            const rejected = await insertContract(client, locked, verified, { status: "REJECTED", compatibility: comparison, validatedBy: subject.staffId });
            await approval(client, locked, { decision: "CONTRACT_REJECTED", actorId: subject.staffId, reasonCode: "CONTRACT_BREAKING", contractId: rejected.id }, ctx);
            return { rejected: true, reason: "CONTRACT_BREAKING", contract_id: rejected.id, changes: comparison.changes };
          }
          contractId = (await insertContract(client, locked, verified, { status: "VALIDATED", compatibility: comparison, validatedBy: subject.staffId })).id;
        }
        await approval(client, locked, { decision: "CONTRACT_VALIDATED", actorId: subject.staffId, contractId }, ctx);
        return transition(client, locked, "CONTRACT_VALIDATED", subject, { expectedRevision: expected_revision, contractId, set: { manifest_digest: verified.manifestDigest, manifest_revision: verified.manifest.manifest_revision, manifest_expires_at: verified.expiresAt } }, ctx);
      }).then((result) => {
        if (result && result.rejected) throw new OnboardingError("CONTRACT_BREAKING", 409, result.changes.slice(0, 10));
        return result;
      });
    },

    async reviewPolicy(subject, id, { expected_revision, evidence_ref } = {}, ctx) {
      await authz(subject, "integration.review", ctx);
      if (evidence_ref !== undefined && !EVIDENCE.test(String(evidence_ref))) throw new OnboardingError("EVIDENCE_REF_INVALID", 400);
      return withTx(pool, async (client) => transition(client, await lockRow(client, id), "POLICY_REVIEWED", subject, { expectedRevision: expected_revision, evidenceRef: evidence_ref }, ctx));
    },

    async approveDataset(subject, id, datasetId, { version, decision = "APPROVE" } = {}, ctx) {
      await authz(subject, "integration.review", ctx);
      if (!new RegExp(C.PATTERNS.catalogId).test(String(datasetId)) || !new RegExp(C.PATTERNS.semver).test(String(version))) throw new OnboardingError("DATASET_INVALID", 400);
      return withTx(pool, async (client) => {
        const row = await lockRow(client, id);
        if (!["CONTRACT_VALIDATED", "POLICY_REVIEWED", "CERTIFIED_STAGING", "ENABLED"].includes(row.lifecycle_status)) throw new SM.TransitionError("TRANSITION_NOT_ALLOWED");
        if (!I.requireIndependentActor(subject.staffId, [row.requested_by])) throw new SM.TransitionError("INDEPENDENT_REVIEWER_REQUIRED", 403);
        const { rows } = await client.query(`SELECT * FROM ${T}hq_product_admin_datasets WHERE product_admin_id = $1 AND dataset_id = $2 AND version = $3 FOR UPDATE`, [id, datasetId, version]);
        const ds = rows[0];
        if (!ds) throw new OnboardingError("UNKNOWN_DATASET", 404);
        if (ds.approval_status !== "PROPOSED") throw new OnboardingError("DATASET_NOT_PROPOSED", 409);
        assertNoUnresolvedDrift(row);
        if (decision === "APPROVE") await assertDeclaredByCurrentContract(client, row, ds);
        // HQ can only approve what the product itself declares certified.
        const { rows: [source] } = await client.query(`SELECT catalog FROM ${T}hq_product_admin_contracts WHERE id = $1`, [ds.contract_id]);
        const declared = (source.catalog.datasets || []).find((d) => d.dataset_id === ds.dataset_id && d.version === ds.version);
        if (decision === "APPROVE" && (!declared || declared.readiness !== "CERTIFIED_BY_PRODUCT")) throw new OnboardingError("DATASET_NOT_CERTIFIED_BY_PRODUCT", 409);
        const approve = decision === "APPROVE" && C.HQ_SYNCABLE_PRIVACY.includes(ds.privacy_class);
        await client.query(`UPDATE ${T}hq_product_admin_datasets SET approval_status = $2, approved_by = $3, approved_at = $4 WHERE id = $1`,
          [ds.id, approve ? "APPROVED" : "REJECTED", approve ? subject.staffId : null, approve ? new Date(now()) : null]);
        await approval(client, row, { decision: approve ? "DATASET_APPROVED" : "DATASET_REJECTED", actorId: subject.staffId, datasetRowId: ds.id, reasonCode: approve ? null : (decision === "APPROVE" ? "RESTRICTED_DATASET" : "REVIEWER_REJECTED") }, ctx);
        await audit(client, subject, row, "integration.dataset", ctx, { dataset_id: datasetId, decision: approve ? "APPROVED" : "REJECTED" });
        if (decision === "APPROVE" && !approve) return { rejected: true };
        return { dataset_row_id: ds.id, approval_status: approve ? "APPROVED" : "REJECTED" };
      }).then((r) => { if (r.rejected) throw new OnboardingError("RESTRICTED_DATASET", 422); return r; });
    },

    async certifyStaging(subject, id, { expected_revision, evidence_ref } = {}, ctx) {
      await authz(subject, "integration.certify", ctx);
      if (!EVIDENCE.test(String(evidence_ref || ""))) throw new OnboardingError("EVIDENCE_REF_REQUIRED", 400);
      return withTx(pool, async (client) => {
        const row = await lockRow(client, id);
        if (row.revision !== expected_revision) throw new SM.TransitionError("STALE_REVISION");
        const contract = await candidateContract(client, id);
        if (!contract) throw new OnboardingError("NO_VALIDATED_CONTRACT", 409);
        if (await approvedDatasetCount(client, id) === 0) throw new OnboardingError("NO_APPROVED_DATASET", 409);
        if (contract.status === "VALIDATED") {
          if (contract.validated_by === subject.staffId) throw new SM.TransitionError("INDEPENDENT_REVIEWER_REQUIRED", 403);
          await client.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'CERTIFIED', certified_by = $2, certified_at = $3, certification_evidence_ref = $4 WHERE id = $1`, [contract.id, subject.staffId, new Date(now()), evidence_ref]);
          await approval(client, row, { decision: "CONTRACT_CERTIFIED", actorId: subject.staffId, contractId: contract.id, evidenceRef: evidence_ref }, ctx);
        } else if (!["CERTIFIED", "ACTIVE"].includes(contract.status)) {
          throw new OnboardingError("CONTRACT_NOT_CERTIFIABLE", 409);
        }
        return transition(client, row, "CERTIFIED_STAGING", subject, { expectedRevision: expected_revision, evidenceRef: evidence_ref, contractId: contract.id }, ctx);
      });
    },

    // Final approval: CERTIFIED_STAGING -> ENABLED. Activates the certified
    // contract; only now may synchronization be scheduled.
    async approve(subject, id, { expected_revision } = {}, ctx) {
      await authz(subject, "integration.approve", ctx);
      return withTx(pool, async (client) => {
        const row = await lockRow(client, id);
        if (row.revision !== expected_revision) throw new SM.TransitionError("STALE_REVISION");
        const contract = await candidateContract(client, id);
        if (!contract || !["CERTIFIED", "ACTIVE"].includes(contract.status)) throw new OnboardingError("CONTRACT_NOT_CERTIFIED", 409);
        if (!row.identity_verified_at) throw new OnboardingError("IDENTITY_NOT_VERIFIED", 409);
        if (!row.manifest_expires_at || row.manifest_expires_at.getTime() <= now()) throw new OnboardingError("MANIFEST_EXPIRED", 409);
        if (await approvedDatasetCount(client, id) === 0) throw new OnboardingError("NO_APPROVED_DATASET", 409);
        SM.assertTransition({ from: row.lifecycle_status, to: "ENABLED", actorId: subject.staffId, requestedBy: row.requested_by, certifiedBy: contract.certified_by, expectedRevision: expected_revision, currentRevision: row.revision });
        if (contract.status === "CERTIFIED") {
          await client.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'SUPERSEDED' WHERE product_admin_id = $1 AND status = 'ACTIVE'`, [id]);
          await client.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'ACTIVE', activated_at = $2 WHERE id = $1`, [contract.id, new Date(now())]);
          await approval(client, row, { decision: "CONTRACT_ACTIVATED", actorId: subject.staffId, contractId: contract.id }, ctx);
        }
        return transition(client, row, "ENABLED", subject, { expectedRevision: expected_revision, certifiedBy: contract.certified_by, contractId: contract.id, set: { current_contract_id: contract.id, activated_at: new Date(now()), activated_by: subject.staffId, drift_status: "NONE" } }, ctx);
      });
    },

    async reject(subject, id, { expected_revision, reason_code } = {}, ctx) {
      await authz(subject, "integration.review", ctx);
      if (!REASON.test(String(reason_code || ""))) throw new OnboardingError("REASON_CODE_REQUIRED", 400);
      return withTx(pool, async (client) => transition(client, await lockRow(client, id), "REJECTED", subject, { expectedRevision: expected_revision, reasonCode: reason_code }, ctx));
    },

    async suspend(subject, id, { expected_revision, reason_code } = {}, ctx) {
      await authz(subject, "integration.suspend", ctx);
      if (!REASON.test(String(reason_code || ""))) throw new OnboardingError("REASON_CODE_REQUIRED", 400);
      return withTx(pool, async (client) => transition(client, await lockRow(client, id), "SUSPENDED", subject, { expectedRevision: expected_revision, reasonCode: reason_code, set: { suspended_at: new Date(now()), suspended_by: subject.staffId, suspension_reason: reason_code, sync_status: "STOPPED" } }, ctx));
    },

    // Permanent. A revoked registration never returns; re-onboarding needs a
    // new registration with a new service instance.
    async revoke(subject, id, { expected_revision, reason_code } = {}, ctx) {
      await authz(subject, "integration.revoke", ctx);
      if (!REASON.test(String(reason_code || ""))) throw new OnboardingError("REASON_CODE_REQUIRED", 400);
      return withTx(pool, async (client) => {
        const row = await lockRow(client, id);
        await client.query(`UPDATE ${T}hq_product_admin_subscriptions SET enabled = false, status = 'SUSPENDED', policy_block_reason = 'PRODUCT_REVOKED', updated_at = now() WHERE product_admin_id = $1`, [id]);
        await client.query(`UPDATE ${T}hq_product_admin_sync_cursors SET lease_owner = NULL, lease_expires_at = NULL WHERE subscription_id IN (SELECT id FROM ${T}hq_product_admin_subscriptions WHERE product_admin_id = $1)`, [id]);
        return transition(client, row, "REVOKED", subject, { expectedRevision: expected_revision, reasonCode: reason_code, set: { revoked_at: new Date(now()), revoked_by: subject.staffId, revocation_reason: reason_code, sync_status: "STOPPED" } }, ctx);
      });
    },

    // SUSPENDED -> REQUESTED, only by an explicit approver. Every gate must
    // then pass again; a new manifest alone never reactivates anything.
    async resumeReview(subject, id, { expected_revision, reason_code } = {}, ctx) {
      await authz(subject, "integration.approve", ctx);
      if (!REASON.test(String(reason_code || ""))) throw new OnboardingError("REASON_CODE_REQUIRED", 400);
      return withTx(pool, async (client) => transition(client, await lockRow(client, id), "REQUESTED", subject, { expectedRevision: expected_revision, reasonCode: reason_code, reviewedFromSuspension: true, set: { identity_verified_at: null } }, ctx));
    },

    // Drift on an ENABLED product: record a new candidate revision. Additive
    // revisions wait for certification and explicit activation; breaking ones
    // are rejected and require a new major onboarding with a dual-read plan.
    async proposeContractRevision(subject, id, ctx) {
      await authz(subject, "integration.verify", ctx);
      const row = await getRow(id);
      if (row.lifecycle_status !== "ENABLED") throw new SM.TransitionError("TRANSITION_NOT_ALLOWED");
      const verified = await fetchVerifiedManifest(row, { minimumRevision: row.manifest_revision });
      return withTx(pool, async (client) => {
        const locked = await lockRow(client, id);
        const active = await activeContract(client, id);
        if (active.catalog_digest === verified.catalogDigest) throw new OnboardingError("NO_CONTRACT_CHANGE", 409);
        const comparison = C.compareCatalogs(active.catalog, catalogOf(verified.manifest));
        const breaking = comparison.decision === "BREAKING";
        const contract = await insertContract(client, locked, verified, { status: breaking ? "REJECTED" : "VALIDATED", compatibility: comparison, validatedBy: subject.staffId });
        await approval(client, locked, { decision: breaking ? "CONTRACT_REJECTED" : "CONTRACT_VALIDATED", actorId: subject.staffId, contractId: contract.id, reasonCode: breaking ? "CONTRACT_BREAKING" : null }, ctx);
        await client.query(`UPDATE ${T}hq_product_admins SET drift_status = $2, drift_detected_at = $3 WHERE id = $1`, [id, breaking ? "BREAKING_DETECTED" : "ADDITIVE_PENDING_REVIEW", new Date(now())]);
        return { contract_id: contract.id, revision: contract.revision, decision: comparison.decision, activation: C.activationDecision(comparison), changes: comparison.changes.slice(0, 50) };
      }).then((result) => {
        // The rejected revision is recorded; the caller is told it cannot activate.
        if (result.decision === "BREAKING") throw new OnboardingError("CONTRACT_BREAKING", 409, result.changes);
        return result;
      });
    },

    async certifyContract(subject, id, contractId, { evidence_ref } = {}, ctx) {
      await authz(subject, "integration.certify", ctx);
      if (!EVIDENCE.test(String(evidence_ref || ""))) throw new OnboardingError("EVIDENCE_REF_REQUIRED", 400);
      return withTx(pool, async (client) => {
        const row = await lockRow(client, id);
        const { rows } = await client.query(`SELECT * FROM ${T}hq_product_admin_contracts WHERE id = $1 AND product_admin_id = $2 FOR UPDATE`, [contractId, id]);
        if (!rows[0]) throw new OnboardingError("UNKNOWN_CONTRACT", 404);
        if (rows[0].status !== "VALIDATED") throw new OnboardingError("CONTRACT_NOT_CERTIFIABLE", 409);
        if (rows[0].validated_by === subject.staffId) throw new SM.TransitionError("INDEPENDENT_REVIEWER_REQUIRED", 403);
        await client.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'CERTIFIED', certified_by = $2, certified_at = $3, certification_evidence_ref = $4 WHERE id = $1`, [contractId, subject.staffId, new Date(now()), evidence_ref]);
        await approval(client, row, { decision: "CONTRACT_CERTIFIED", actorId: subject.staffId, contractId, evidenceRef: evidence_ref }, ctx);
        return { contract_id: contractId, status: "CERTIFIED" };
      });
    },

    async activateContract(subject, id, contractId, { expected_revision } = {}, ctx) {
      await authz(subject, "integration.approve", ctx);
      return withTx(pool, async (client) => {
        const row = await lockRow(client, id);
        if (row.lifecycle_status !== "ENABLED") throw new SM.TransitionError("TRANSITION_NOT_ALLOWED");
        if (row.revision !== expected_revision) throw new SM.TransitionError("STALE_REVISION");
        const { rows } = await client.query(`SELECT * FROM ${T}hq_product_admin_contracts WHERE id = $1 AND product_admin_id = $2 FOR UPDATE`, [contractId, id]);
        const contract = rows[0];
        if (!contract) throw new OnboardingError("UNKNOWN_CONTRACT", 404);
        if (contract.status !== "CERTIFIED") throw new OnboardingError("CONTRACT_NOT_CERTIFIED", 409);
        if (contract.certified_by === subject.staffId) throw new SM.TransitionError("INDEPENDENT_APPROVER_REQUIRED", 403);
        const decision = C.activationDecision(contract.compatibility, { reviewed: true });
        if (!decision.allowed) throw new OnboardingError(decision.reason, 409);
        // The stored comparison was made when the revision was proposed, by
        // the comparator of that time, against the contract active then.
        // Re-compare against the contract active now with the current
        // comparator: a revision that is no longer purely additive (or that
        // a since-corrected comparator mis-classified) is refused.
        const { rows: [current] } = await client.query(`SELECT * FROM ${T}hq_product_admin_contracts WHERE product_admin_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [id]);
        if (!current || current.id !== row.current_contract_id) throw new OnboardingError("NO_ACTIVE_CONTRACT", 409);
        const fresh = C.activationDecision(C.compareCatalogs(current.catalog, contract.catalog), { reviewed: true });
        if (!fresh.allowed) throw new OnboardingError(fresh.reason === "IDENTICAL" ? "NO_CONTRACT_CHANGE" : fresh.reason, 409);
        await client.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'SUPERSEDED' WHERE product_admin_id = $1 AND status = 'ACTIVE'`, [id]);
        await client.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'ACTIVE', activated_at = $2 WHERE id = $1`, [contractId, new Date(now())]);
        const { rows: updated } = await client.query(`UPDATE ${T}hq_product_admins SET current_contract_id = $2, drift_status = 'NONE', revision = revision + 1 WHERE id = $1 AND revision = $3 RETURNING *`, [id, contractId, expected_revision]);
        if (!updated[0]) throw new SM.TransitionError("STALE_REVISION");
        await approval(client, row, { decision: "CONTRACT_ACTIVATED", actorId: subject.staffId, contractId, expectedRevision: expected_revision, resultingRevision: updated[0].revision }, ctx);
        await audit(client, subject, row, "integration.contract.activate", ctx, { contract_revision: contract.revision });
        return updated[0];
      });
    },

    async createSubscription(subject, id, input = {}, ctx) {
      await authz(subject, "integration.subscriptions.manage", ctx);
      const allowedKeys = ["dataset_id", "version", "consumer_department", "allowed_scope", "freshness_target_seconds", "poll_interval_seconds", "page_limit", "enabled"];
      for (const key of Object.keys(input)) if (!allowedKeys.includes(key)) throw new OnboardingError("UNKNOWN_FIELD", 400);
      return withTx(pool, async (client) => {
        const row = await lockRow(client, id);
        if (!["POLICY_REVIEWED", "CERTIFIED_STAGING", "ENABLED"].includes(row.lifecycle_status)) throw new SM.TransitionError("TRANSITION_NOT_ALLOWED");
        const { rows } = await client.query(`SELECT * FROM ${T}hq_product_admin_datasets WHERE product_admin_id = $1 AND dataset_id = $2 AND version = $3`, [id, input.dataset_id, input.version]);
        const ds = rows[0];
        if (!ds) throw new OnboardingError("UNKNOWN_DATASET", 404);
        if (ds.approval_status !== "APPROVED" || !C.HQ_SYNCABLE_PRIVACY.includes(ds.privacy_class)) throw new OnboardingError("DATASET_NOT_APPROVED", 409);
        assertNoUnresolvedDrift(row);
        await assertDeclaredByCurrentContract(client, row, ds);
        if (!ds.authorized_departments.includes(input.consumer_department)) throw new OnboardingError("DEPARTMENT_NOT_AUTHORIZED", 403);
        const required = ["market", "organization"].filter((d) => ds.scope_dimensions.includes(d));
        if (!validScope(input.allowed_scope, { allowedDims: ds.scope_dimensions, required })) throw new OnboardingError("ALLOWED_SCOPE_INVALID", 400);
        if (!subsetScope(input.allowed_scope, row.allowed_scope)) throw new OnboardingError("SCOPE_EXCEEDS_PRODUCT", 403);
        const freshness = Number.isInteger(input.freshness_target_seconds) ? input.freshness_target_seconds : ds.freshness_target_seconds;
        const poll = Number.isInteger(input.poll_interval_seconds) ? input.poll_interval_seconds : 60;
        const pageLimit = Number.isInteger(input.page_limit) ? input.page_limit : 100;
        const subId = randomUUID();
        try {
          await client.query(
            `INSERT INTO ${T}hq_product_admin_subscriptions (id, product_admin_id, dataset_row_id, consumer_department, schema_revision, schema_digest, allowed_scope, freshness_target_seconds, poll_interval_seconds, page_limit, enabled, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [subId, id, ds.id, input.consumer_department, ds.version, ds.schema_digest, JSON.stringify(input.allowed_scope), freshness, poll, pageLimit, input.enabled === true, subject.staffId]);
        } catch (err) {
          if (err.code === "23505") throw new OnboardingError("SUBSCRIPTION_EXISTS", 409);
          if (err.code === "23514") throw new OnboardingError("SUBSCRIPTION_INVALID", 400);
          throw err;
        }
        await approval(client, row, { decision: "SUBSCRIPTION_CHANGED", actorId: subject.staffId, subscriptionId: subId, datasetRowId: ds.id }, ctx);
        await audit(client, subject, row, "integration.subscription.create", ctx, { dataset_id: ds.dataset_id, enabled: input.enabled === true });
        return { subscription_id: subId };
      });
    },

    async setSubscriptionEnabled(subject, id, subscriptionId, enabled, ctx) {
      await authz(subject, "integration.subscriptions.manage", ctx);
      return withTx(pool, async (client) => {
        const row = await lockRow(client, id);
        // A terminal registration keeps its history; its subscriptions cannot change.
        if (["REVOKED", "REJECTED"].includes(row.lifecycle_status)) throw new OnboardingError("REGISTRATION_TERMINAL", 409);
        if (enabled) assertNoUnresolvedDrift(row);
        const { rows } = await client.query(`UPDATE ${T}hq_product_admin_subscriptions SET enabled = $3, status = CASE WHEN $3 THEN 'ACTIVE' ELSE status END, updated_at = now() WHERE id = $1 AND product_admin_id = $2 AND (NOT $3 OR status <> 'POLICY_BLOCKED') RETURNING id, enabled, status`, [subscriptionId, id, Boolean(enabled)]);
        if (!rows[0]) throw new OnboardingError("UNKNOWN_SUBSCRIPTION", 404);
        await approval(client, row, { decision: "SUBSCRIPTION_CHANGED", actorId: subject.staffId, subscriptionId, reasonCode: enabled ? "ENABLED" : "DISABLED" }, ctx);
        return rows[0];
      });
    },

    async grant(subject, input = {}, ctx) {
      await authz(subject, "integration.grants.manage", ctx);
      const grant = {
        id: randomUUID(), grant_kind: input.grant_kind, product_id: input.grant_kind === "PRODUCT" ? input.product_id : null, staff_id: input.staff_id,
        role: input.role || null, effect: input.effect || "ALLOW", actions: input.actions, datasets: input.datasets || [], scope: input.scope || {},
        expires_at: input.expires_at || null, revoked_at: null,
      };
      const errors = I.grantErrors(grant);
      if (errors.length) throw new OnboardingError("GRANT_INVALID", 400, errors.slice(0, 5));
      if (grant.role !== null && !/^[a-z][a-z0-9_.-]{1,63}$/.test(grant.role)) throw new OnboardingError("GRANT_INVALID", 400);
      if (grant.expires_at !== null && !(Date.parse(grant.expires_at) > now())) throw new OnboardingError("GRANT_EXPIRY_INVALID", 400);
      if (grant.staff_id === subject.staffId) throw new OnboardingError("SELF_GRANT_DENIED", 403);
      return withTx(pool, async (client) => {
        let row = null;
        if (grant.grant_kind === "PRODUCT") {
          const { rows } = await client.query(`SELECT * FROM ${T}hq_product_admins WHERE product_id = $1 AND environment = $2 AND lifecycle_status NOT IN ('REJECTED','REVOKED')`, [grant.product_id, environment]);
          row = rows[0];
          if (!row) throw new OnboardingError("PRODUCT_NOT_REGISTERED", 404);
          if (!subsetScope(grant.scope, row.allowed_scope)) throw new OnboardingError("SCOPE_EXCEEDS_PRODUCT", 403);
          if (grant.datasets.length) {
            const { rows: ds } = await client.query(`SELECT DISTINCT dataset_id FROM ${T}hq_product_admin_datasets WHERE product_admin_id = $1 AND approval_status = 'APPROVED' AND dataset_id = ANY($2)`, [row.id, grant.datasets]);
            if (ds.length !== grant.datasets.length) throw new OnboardingError("DATASET_NOT_APPROVED", 409);
          }
        }
        await client.query(
          `INSERT INTO ${T}hq_product_admin_grants (id, grant_kind, product_id, staff_id, role, effect, actions, datasets, scope, expires_at, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [grant.id, grant.grant_kind, grant.product_id, grant.staff_id, grant.role, grant.effect, grant.actions, grant.datasets, JSON.stringify(grant.scope), grant.expires_at, subject.staffId]);
        await audit(client, subject, row, "integration.grant.create", ctx, { grant_ref: grant.id, grant_kind: grant.grant_kind, staff_ref: grant.staff_id, actions: grant.actions, effect: grant.effect });
        return { grant_id: grant.id };
      });
    },

    async revokeGrant(subject, grantId, { reason_code } = {}, ctx) {
      await authz(subject, "integration.grants.manage", ctx);
      if (!REASON.test(String(reason_code || ""))) throw new OnboardingError("REASON_CODE_REQUIRED", 400);
      return withTx(pool, async (client) => {
        const { rows } = await client.query(`UPDATE ${T}hq_product_admin_grants SET revoked_at = now(), revoked_by = $2, revocation_reason = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING id, product_id`, [grantId, subject.staffId, reason_code]);
        if (!rows[0]) throw new OnboardingError("UNKNOWN_GRANT", 404);
        await recordAudit(client, { correlationId: ctx.correlationId, actorType: "STAFF", actorId: subject.staffId, productId: rows[0].product_id, action: "integration.grant.revoke", outcome: "RECORDED", metadata: { grant_ref: grantId } });
        return { grant_id: grantId, revoked: true };
      });
    },
  };
}

module.exports = { createOnboarding, OnboardingError, validScope, subsetScope, EndpointError };
