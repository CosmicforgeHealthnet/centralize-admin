"use client";

// One product integration: lifecycle, monitoring, datasets, subscriptions,
// operations switch, contracts and the approval history. Every write goes
// through a confirmation that names the exact server action, steps up MFA
// when the gateway asks for it, and shows the server's refusal reason.

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import ProductDataState, { RefreshButton } from "@/components/products/ProductDataState";
import { registrationKeys, useAdminMutation, useIntegration, useIntegrationMonitoring } from "@/lib/product-integrations.queries";
import * as svc from "@/lib/product-integrations.service";
import type { IntegrationDataset, IntegrationDetail as Detail, LifecycleTransition } from "@/lib/product-integrations.service";
import {
  ActionButton,
  Card,
  ConfirmActionDialog,
  KeyValue,
  ScopeList,
  StatusPill,
  SuccessNote,
  shortId,
  useRefusal,
  useStaffId,
  when,
  type ConfirmField,
} from "./admin-ui";
import { AVAILABLE, REASON_FIELD, TRANSITIONS, evidenceField, independenceBlock, type PlatformPermission } from "./lifecycle";
import SubscriptionCreateDialog from "./SubscriptionCreateDialog";

/** One confirmable server action. */
interface ActionSpec {
  key: string;
  title: string;
  action: string;
  description?: string;
  requirements: string[];
  fields: ConfirmField[];
  confirmLabel: string;
  danger?: boolean;
  permission: PlatformPermission;
  run: (values: Record<string, string>) => Promise<unknown>;
  success: (result: unknown) => string;
}

const th = "px-3 py-2 text-left font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
const td = "px-3 py-2 align-top font-poppins text-[12px] text-foreground";

export default function IntegrationDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useIntegration(id);
  const me = useStaffId();
  const { reasonFor, record } = useRefusal();
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);

  const mutation = useAdminMutation<unknown, { spec: ActionSpec; values: Record<string, string> }>("action", ({ spec: s, values }) => s.run(values), {
    invalidate: () => registrationKeys(id),
    onSuccess: (result, { spec: s }) => {
      setSuccess(s.success(result));
      setSpec(null);
    },
    onError: (error, { spec: s }) => record(s.permission, error),
  });

  const open = (s: ActionSpec) => {
    mutation.reset();
    setSuccess(null);
    setSpec(s);
  };

  /** Disabled reason from a known permission refusal, else from the given rule. */
  const blockFor = (permission: PlatformPermission, rule: string | null = null) => {
    const refused = reasonFor(permission);
    return refused ? `Not permitted (${refused}): you do not hold ${permission}.` : rule;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-poppins text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> All integrations
        </button>
      </div>
      <ProductDataState title="Integration" loading={detail.isPending} error={detail.error} onRetry={() => detail.refetch()}>
        {detail.data && (
          <DetailBody
            detail={detail.data}
            me={me}
            blockFor={blockFor}
            open={open}
            success={success}
            refreshing={detail.isFetching}
            onRefresh={() => void detail.refetch()}
            onCreateSubscription={() => {
              setSuccess(null);
              setSubscriptionOpen(true);
            }}
          />
        )}
      </ProductDataState>
      {spec && (
        <ConfirmActionDialog
          open
          onOpenChange={(next) => {
            if (!next) setSpec(null);
          }}
          title={spec.title}
          action={spec.action}
          description={spec.description}
          requirements={spec.requirements}
          fields={spec.fields}
          confirmLabel={spec.confirmLabel}
          danger={spec.danger}
          busy={mutation.isPending}
          error={mutation.error}
          onConfirm={(values) => mutation.mutate({ spec, values })}
        />
      )}
      {detail.data && subscriptionOpen && (
        <SubscriptionCreateDialog
          detail={detail.data}
          onClose={() => setSubscriptionOpen(false)}
          onCreated={(subscriptionId) => {
            setSubscriptionOpen(false);
            setSuccess(`Subscription ${shortId(subscriptionId)} created.`);
          }}
          onRefused={(error) => record("integration.subscriptions.manage", error)}
        />
      )}
    </div>
  );
}

function DetailBody({
  detail,
  me,
  blockFor,
  open,
  success,
  refreshing,
  onRefresh,
  onCreateSubscription,
}: {
  detail: Detail;
  me: string | null;
  blockFor: (permission: PlatformPermission, rule?: string | null) => string | null;
  open: (spec: ActionSpec) => void;
  success: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onCreateSubscription: () => void;
}) {
  const reg = detail.registration;
  const base = `/api/admin/product-integrations/${reg.id}`;
  const terminal = reg.lifecycle_status === "REVOKED" || reg.lifecycle_status === "REJECTED";

  const transitionSpec = (t: LifecycleTransition): ActionSpec => {
    const s = TRANSITIONS[t];
    return {
      key: t,
      title: `Confirm ${t}`,
      action: `POST ${base}/${t} · ${reg.lifecycle_status} → ${s.to} · expected revision ${reg.revision}`,
      requirements: s.requirements,
      fields: s.fields,
      confirmLabel: `Run ${t}`,
      danger: s.danger,
      permission: s.permission,
      run: (values) => svc.transitionIntegration(reg.id, t, { expected_revision: reg.revision, ...values }),
      success: (result) => {
        const r = result as svc.IntegrationRegistration;
        return `${t} done: ${reg.display_name} is now ${r?.lifecycle_status ?? s.to} (revision ${r?.revision ?? "?"}).`;
      },
    };
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-poppins text-[18px] font-semibold text-foreground">{reg.display_name}</h2>
          <p className="font-mono text-[11px] text-muted-foreground">
            {reg.product_id} · {reg.environment} · {reg.service_instance_id} · revision {reg.revision}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill value={reg.lifecycle_status} />
          <RefreshButton onClick={onRefresh} busy={refreshing} label="Reload integration" />
        </div>
      </div>
      <SuccessNote message={success} />

      <Card title="Lifecycle" description="Each step is revision-checked and recorded in the approval history.">
        <KeyValue
          items={[
            ["Status", <StatusPill key="s" value={reg.lifecycle_status} />],
            ["Requested by", reg.requested_by],
            ["Identity verified", when(reg.identity_verified_at)],
            ["Activated", reg.activated_at ? `${when(reg.activated_at)} by ${reg.activated_by}` : "—"],
            ["Endpoint ref", reg.endpoint_ref],
            ["Workload identity", reg.workload_identity],
            ["Signer key", reg.approved_signer_kid],
            ["Allowed scope", <ScopeList key="sc" scope={reg.allowed_scope} />],
            ...(reg.suspension_reason ? ([["Suspension reason", reg.suspension_reason]] as [string, string][]) : []),
            ...(reg.revocation_reason ? ([["Revocation reason", reg.revocation_reason]] as [string, string][]) : []),
          ]}
        />
        <div className="flex flex-wrap gap-2">
          {AVAILABLE[reg.lifecycle_status].map((t) => (
            <ActionButton
              key={t}
              label={TRANSITIONS[t].label}
              variant={TRANSITIONS[t].danger ? "danger" : "primary"}
              disabledReason={blockFor(TRANSITIONS[t].permission, independenceBlock(t, detail, me))}
              onClick={() => open(transitionSpec(t))}
            />
          ))}
          {AVAILABLE[reg.lifecycle_status].length === 0 && (
            <p className="font-poppins text-[12px] text-muted-foreground">No lifecycle step is available from {reg.lifecycle_status}.</p>
          )}
        </div>
      </Card>

      <MonitoringCard
        id={reg.id}
        terminal={terminal}
        blockFor={blockFor}
        onHealthCheck={() =>
          open({
            key: "health-check",
            title: "Confirm health-check",
            action: `POST ${base}/health-check`,
            requirements: ["Permission integration.verify.", "Re-reads the signed manifest and records reachability and drift."],
            fields: [],
            confirmLabel: "Run health-check",
            permission: "integration.verify",
            run: () => svc.runHealthCheck(reg.id),
            success: (r) => {
              const h = r as svc.HealthCheckResult;
              return `Health check recorded: ${h?.health_status ?? "?"}, drift ${h?.drift_status ?? "?"}${h?.reason ? ` (${h.reason})` : ""}${h?.stale ? " — a newer check had already been recorded" : ""}.`;
            },
          })
        }
        onSync={() =>
          open({
            key: "sync",
            title: "Confirm sync",
            action: `POST ${base}/sync`,
            requirements: ["Permission integration.subscriptions.manage.", "Runs one synchronization pass for this product's enabled subscriptions."],
            fields: [],
            confirmLabel: "Run sync",
            permission: "integration.subscriptions.manage",
            run: () => svc.runSyncNow(reg.id),
            success: () => "Synchronization pass finished. Monitoring shows the recorded result.",
          })
        }
      />

      <DatasetsCard detail={detail} me={me} base={base} blockFor={blockFor} open={open} />
      <SubscriptionsCard detail={detail} base={base} blockFor={blockFor} open={open} onCreate={onCreateSubscription} />
      <OperationsCard detail={detail} me={me} base={base} blockFor={blockFor} open={open} />
      <ContractsCard detail={detail} me={me} base={base} blockFor={blockFor} open={open} />
      <HistoryCard detail={detail} />
    </div>
  );
}

// ── Monitoring ────────────────────────────────────────────────────

function MonitoringCard({ id, terminal, blockFor, onHealthCheck, onSync }: { id: string; terminal: boolean; blockFor: (p: PlatformPermission, rule?: string | null) => string | null; onHealthCheck: () => void; onSync: () => void }) {
  const q = useIntegrationMonitoring(id);
  const m = q.data;
  return (
    <Card
      title="Monitoring"
      description="Recorded checks, cursors and sync runs; never inferred from process liveness."
      actions={
        <>
          <ActionButton label="Run health check" onClick={onHealthCheck} disabledReason={blockFor("integration.verify", terminal ? "Closed registrations are not checked." : null)} />
          <ActionButton label="Run sync now" onClick={onSync} disabledReason={blockFor("integration.subscriptions.manage", terminal ? "Closed registrations do not sync." : null)} />
          <RefreshButton onClick={() => void q.refetch()} busy={q.isFetching} label="Reload monitoring" />
        </>
      }
    >
      <ProductDataState title="Monitoring" loading={q.isPending} error={q.error} onRetry={() => q.refetch()} embedded compact>
        {m && (
          <div className="flex flex-col gap-3">
            <KeyValue
              items={[
                ["Connection", <span key="c" className="flex flex-wrap items-center gap-1"><StatusPill value={m.connection.health_status} /> checked {when(m.connection.checked_at)}</span>],
                ["Drift", <span key="d" className="flex flex-wrap items-center gap-1"><StatusPill value={m.drift.status} />{m.drift.detected_at ? ` since ${when(m.drift.detected_at)}` : ""}</span>],
                ["Manifest", m.identity.manifest_revision ? `revision ${m.identity.manifest_revision}, ${m.identity.manifest_expired ? "EXPIRED" : `expires ${when(m.identity.manifest_expires_at)}`}` : "Not verified"],
                ["Contract in force", m.contract ? `revision ${m.contract.revision} (${m.contract.status}), protocol ${m.contract.protocol_major}.${m.contract.protocol_minor}${m.contract.build_sha ? `, build ${m.contract.build_sha.slice(0, 12)}` : ""}` : "None"],
                ["Sync", <span key="s" className="flex flex-wrap items-center gap-1"><StatusPill value={m.sync.status} /> last success {when(m.sync.last_successful_run ?? null)}</span>],
                ["Last 24 h", `${m.sync.failed_runs ?? 0} failed runs · ${m.sync.failed_acks ?? 0} failed acks · ${m.sync.lease_failures ?? 0} lease losses`],
                ["Quarantine", m.quarantine ? `${m.quarantine.open} open of ${m.quarantine.total}` : "—"],
                ["Cursors", `${m.cursors.length} partitions${m.cursors.some((c) => c.gap_from !== null) ? " · gap detected" : ""}`],
              ]}
            />
            {m.alerts_24h.length > 0 && (
              <div>
                <p className="font-poppins text-[11px] font-semibold text-foreground">Alerts (24 h)</p>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {m.alerts_24h.map((a) => (
                    <li key={a.reason_code}><StatusPill value={`${a.reason_code} ×${a.n}`} tone="warn" /></li>
                  ))}
                </ul>
              </div>
            )}
            {m.subscriptions.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <caption className="sr-only">Subscription sync state</caption>
                  <thead><tr className="border-b border-border"><th className={th}>Dataset</th><th className={th}>Department</th><th className={th}>Status</th><th className={th}>Coverage</th><th className={th}>Lag</th><th className={th}>Last success</th></tr></thead>
                  <tbody>
                    {m.subscriptions.map((s) => (
                      <tr key={s.id} className="border-b border-border/50">
                        <td className={td}><span className="font-mono text-[11px]">{s.dataset_id}</span></td>
                        <td className={td}>{s.consumer_department}</td>
                        <td className={td}><StatusPill value={s.status} />{s.policy_block_reason && <span className="ml-1 font-mono text-[10px] text-muted-foreground">{s.policy_block_reason}</span>}</td>
                        <td className={td}><StatusPill value={s.coverage} />{s.gap_status === "GAP_DETECTED" && <StatusPill value="GAP_DETECTED" />}</td>
                        <td className={td}>{s.lag_seconds === null ? "No observation" : `${s.lag_seconds}s`}{s.freshness_target_seconds ? ` / target ${s.freshness_target_seconds}s` : ""}</td>
                        <td className={td}>{when(s.last_success_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </ProductDataState>
    </Card>
  );
}

// ── Datasets ──────────────────────────────────────────────────────

const DATASET_DECIDABLE = ["CONTRACT_VALIDATED", "POLICY_REVIEWED", "CERTIFIED_STAGING", "ENABLED"];

function DatasetsCard({ detail, me, base, blockFor, open }: { detail: Detail; me: string | null; base: string; blockFor: (p: PlatformPermission, rule?: string | null) => string | null; open: (s: ActionSpec) => void }) {
  const reg = detail.registration;
  const stateRule = DATASET_DECIDABLE.includes(reg.lifecycle_status) ? null : `Datasets are decided from CONTRACT_VALIDATED onward (now ${reg.lifecycle_status}).`;
  const selfRule = me && reg.requested_by === me ? "Two-person rule: you requested this registration, so someone else must decide datasets." : null;
  const decide = (ds: IntegrationDataset, decision: "APPROVE" | "REJECT"): ActionSpec => ({
    key: `dataset-${ds.id}-${decision}`,
    title: `Confirm dataset ${decision === "APPROVE" ? "approval" : "rejection"}`,
    action: `POST ${base}/datasets/${ds.dataset_id}/approve · version ${ds.version} · decision ${decision}`,
    description: ds.privacy_class === "RESTRICTED_PII" && decision === "APPROVE" ? "This dataset is RESTRICTED_PII. PIC never synchronizes restricted data to HQ and will record the approval as rejected." : undefined,
    requirements: ["Permission integration.review.", "Two-person rule: someone other than the requester.", "Approval needs the contract in force to declare this exact version, certified as ready by the product, and no unresolved drift."],
    fields: [],
    confirmLabel: decision === "APPROVE" ? "Approve dataset" : "Reject dataset",
    danger: decision === "REJECT",
    permission: "integration.review",
    run: () => svc.decideDataset(reg.id, ds.dataset_id, { version: ds.version, decision }),
    success: (r) => `Dataset ${ds.dataset_id} ${ds.version} is now ${(r as svc.DatasetDecisionResult)?.approval_status ?? "decided"}.`,
  });
  return (
    <Card title="Datasets" description="Proposed by the validated contract; only approved, non-restricted datasets can be subscribed.">
      {detail.datasets.length === 0 ? (
        <p className="font-poppins text-[12px] text-muted-foreground">No datasets recorded yet (they appear once a contract is validated).</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <caption className="sr-only">Datasets</caption>
            <thead><tr className="border-b border-border"><th className={th}>Dataset</th><th className={th}>Version</th><th className={th}>Privacy</th><th className={th}>Status</th><th className={th}>Departments</th><th className={th}>Decision</th></tr></thead>
            <tbody>
              {detail.datasets.map((ds) => (
                <tr key={ds.id} className="border-b border-border/50">
                  <td className={td}><span className="font-mono text-[11px]">{ds.dataset_id}</span></td>
                  <td className={td}>{ds.version}</td>
                  <td className={td}><StatusPill value={ds.privacy_class} tone={ds.privacy_class === "RESTRICTED_PII" ? "bad" : "muted"} /></td>
                  <td className={td}><StatusPill value={ds.approval_status} />{ds.approved_by && <span className="block text-[10px] text-muted-foreground">by {ds.approved_by}</span>}</td>
                  <td className={td}>{ds.authorized_departments.join(", ") || "—"}</td>
                  <td className={td}>
                    {ds.approval_status === "PROPOSED" ? (
                      <span className="flex flex-wrap gap-1.5">
                        <ActionButton label="Approve" ariaLabel={`Approve ${ds.dataset_id}`} variant="primary" disabledReason={blockFor("integration.review", stateRule ?? selfRule)} onClick={() => open(decide(ds, "APPROVE"))} />
                        <ActionButton label="Reject" ariaLabel={`Reject ${ds.dataset_id}`} variant="danger" disabledReason={blockFor("integration.review", stateRule ?? selfRule)} onClick={() => open(decide(ds, "REJECT"))} />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Subscriptions ─────────────────────────────────────────────────

const SUBSCRIBABLE = ["POLICY_REVIEWED", "CERTIFIED_STAGING", "ENABLED"];

function SubscriptionsCard({ detail, base, blockFor, open, onCreate }: { detail: Detail; base: string; blockFor: (p: PlatformPermission, rule?: string | null) => string | null; open: (s: ActionSpec) => void; onCreate: () => void }) {
  const reg = detail.registration;
  const terminal = reg.lifecycle_status === "REVOKED" || reg.lifecycle_status === "REJECTED";
  const approved = detail.datasets.filter((d) => d.approval_status === "APPROVED" && d.privacy_class !== "RESTRICTED_PII");
  const createRule = !SUBSCRIBABLE.includes(reg.lifecycle_status)
    ? `Subscriptions can be created from POLICY_REVIEWED onward (now ${reg.lifecycle_status}).`
    : approved.length === 0
      ? "No approved dataset to subscribe to."
      : null;
  const datasetOf = (rowId: string) => detail.datasets.find((d) => d.id === rowId);
  const toggle = (subId: string, label: string, enabled: boolean): ActionSpec => ({
    key: `sub-${subId}-${enabled}`,
    title: `Confirm subscription ${enabled ? "enable" : "disable"}`,
    action: `POST ${base}/subscriptions/${subId}/${enabled ? "enable" : "disable"} · ${label}`,
    requirements: ["Permission integration.subscriptions.manage.", ...(enabled ? ["Refused while contract drift is unresolved or the subscription is policy-blocked."] : ["Synchronization of this dataset stops at the next pass."])],
    fields: [],
    confirmLabel: enabled ? "Enable subscription" : "Disable subscription",
    danger: !enabled,
    permission: "integration.subscriptions.manage",
    run: () => svc.setSubscriptionEnabled(reg.id, subId, enabled),
    success: (r) => {
      const s = r as svc.SubscriptionToggleResult;
      return `Subscription ${label} is now ${s?.enabled ? "enabled" : "disabled"} (${s?.status ?? "?"}).`;
    },
  });
  return (
    <Card
      title="Subscriptions"
      description="What HQ synchronizes, for which department and exact scope."
      actions={<ActionButton label="Create subscription" variant="primary" onClick={onCreate} disabledReason={blockFor("integration.subscriptions.manage", createRule)} />}
    >
      {detail.subscriptions.length === 0 ? (
        <p className="font-poppins text-[12px] text-muted-foreground">No subscriptions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <caption className="sr-only">Subscriptions</caption>
            <thead><tr className="border-b border-border"><th className={th}>Dataset</th><th className={th}>Department</th><th className={th}>Enabled</th><th className={th}>Status</th><th className={th}>Coverage</th><th className={th}>Last success</th><th className={th}>Action</th></tr></thead>
            <tbody>
              {detail.subscriptions.map((s) => {
                const ds = datasetOf(s.dataset_row_id);
                const label = ds ? `${ds.dataset_id} → ${s.consumer_department}` : `${shortId(s.id)} → ${s.consumer_department}`;
                return (
                  <tr key={s.id} className="border-b border-border/50">
                    <td className={td}><span className="font-mono text-[11px]">{ds ? `${ds.dataset_id} ${ds.version}` : shortId(s.dataset_row_id)}</span></td>
                    <td className={td}>{s.consumer_department}</td>
                    <td className={td}>{s.enabled ? "Yes" : "No"}</td>
                    <td className={td}><StatusPill value={s.status} /></td>
                    <td className={td}><StatusPill value={s.coverage} />{s.gap_status === "GAP_DETECTED" && <StatusPill value="GAP_DETECTED" />}</td>
                    <td className={td}>{when(s.last_success_at)}</td>
                    <td className={td}>
                      {s.enabled ? (
                        <ActionButton label="Disable" ariaLabel={`Disable subscription ${label}`} variant="danger" disabledReason={blockFor("integration.subscriptions.manage", terminal ? "Closed registration." : null)} onClick={() => open(toggle(s.id, label, false))} />
                      ) : (
                        <ActionButton
                          label="Enable"
                          ariaLabel={`Enable subscription ${label}`}
                          disabledReason={blockFor("integration.subscriptions.manage", terminal ? "Closed registration." : s.status === "POLICY_BLOCKED" ? "Policy-blocked subscriptions cannot be enabled." : null)}
                          onClick={() => open(toggle(s.id, label, true))}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Operations switch ─────────────────────────────────────────────

function OperationsCard({ detail, me, base, blockFor, open }: { detail: Detail; me: string | null; base: string; blockFor: (p: PlatformPermission, rule?: string | null) => string | null; open: (s: ActionSpec) => void }) {
  const reg = detail.registration;
  const enableRule =
    reg.lifecycle_status !== "ENABLED"
      ? `Operations can be enabled only for an ENABLED product (now ${reg.lifecycle_status}).`
      : me && (reg.requested_by === me || reg.activated_by === me)
        ? "Two-person rule: you requested or activated this product, so someone else must enable operations."
        : reg.drift_status !== "NONE"
          ? `Unresolved contract drift (${reg.drift_status}) blocks enabling.`
          : null;
  const spec = (enabled: boolean): ActionSpec => ({
    key: `ops-${enabled}`,
    title: `Confirm operations ${enabled ? "enable" : "disable"}`,
    action: `POST ${base}/operations/${enabled ? "enable" : "disable"} · expected revision ${reg.revision}`,
    description: enabled
      ? "Allows governed commands to be forwarded to this Product Admin. It never makes a capability executable by itself: the Product Admin and its source still decide every command."
      : "Immediately stops forwarding governed commands for this product.",
    requirements: enabled
      ? ["Permission integration.approve and an evidence reference.", "Two-person rule: someone other than the requester and the activator.", "ENABLED product, current revision, no unresolved drift."]
      : ["Permission integration.suspend and a reason code."],
    fields: enabled ? [evidenceField(true)] : [REASON_FIELD],
    confirmLabel: enabled ? "Enable operations" : "Disable operations",
    danger: !enabled,
    permission: enabled ? "integration.approve" : "integration.suspend",
    run: (values) => svc.setOperationsEnabled(reg.id, enabled, enabled ? { expected_revision: reg.revision, evidence_ref: values.evidence_ref } : { expected_revision: reg.revision, reason_code: values.reason_code }),
    success: (r) => {
      const o = r as svc.OperationsSwitchResult;
      return o?.changed === false ? `Operations were already ${o.operations_enabled ? "enabled" : "disabled"}; nothing changed.` : `Operations ${o?.operations_enabled ? "enabled" : "disabled"} (revision ${o?.revision ?? "?"}).`;
    },
  });
  return (
    <Card title="Operations" description="Product-level switch for forwarding governed commands.">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill value={reg.operations_enabled ? "ENABLED" : "DISABLED"} tone={reg.operations_enabled ? "good" : "muted"} label="Operations" />
        {reg.operations_enabled ? (
          <ActionButton label="Disable operations" variant="danger" disabledReason={blockFor("integration.suspend")} onClick={() => open(spec(false))} />
        ) : (
          <ActionButton label="Enable operations" variant="primary" disabledReason={blockFor("integration.approve", enableRule)} onClick={() => open(spec(true))} />
        )}
      </div>
    </Card>
  );
}

// ── Contracts ─────────────────────────────────────────────────────

function ContractsCard({ detail, me, base, blockFor, open }: { detail: Detail; me: string | null; base: string; blockFor: (p: PlatformPermission, rule?: string | null) => string | null; open: (s: ActionSpec) => void }) {
  const reg = detail.registration;
  const enabled = reg.lifecycle_status === "ENABLED";
  const propose: ActionSpec = {
    key: "propose",
    title: "Confirm contracts/propose",
    action: `POST ${base}/contracts/propose`,
    requirements: ["Permission integration.verify.", "PIC fetches the product's current signed manifest; additive changes wait for certification and activation, breaking changes are recorded as rejected."],
    fields: [],
    confirmLabel: "Propose revision",
    permission: "integration.verify",
    run: () => svc.proposeContract(reg.id),
    success: (r) => {
      const p = r as svc.ContractProposalResult;
      const activation = p?.activation && typeof p.activation === "object" ? ` Activation: ${p.activation.allowed ? "allowed after review" : `blocked (${String(p.activation.reason ?? "see server")})`}.` : "";
      return `Contract revision ${p?.revision ?? "?"} proposed (${p?.decision ?? "?"}, ${p?.changes?.length ?? 0} changes).${activation} It needs certification by someone else, then activation.`;
    },
  };
  return (
    <Card
      title="Contracts"
      description="Validated → certified (second person, evidence) → active (third check: not the certifier)."
      actions={<ActionButton label="Propose new revision" onClick={() => open(propose)} disabledReason={blockFor("integration.verify", enabled ? null : "Revisions are proposed only for ENABLED products.")} />}
    >
      {detail.contracts.length === 0 ? (
        <p className="font-poppins text-[12px] text-muted-foreground">No contracts yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <caption className="sr-only">Contracts</caption>
            <thead><tr className="border-b border-border"><th className={th}>Revision</th><th className={th}>Status</th><th className={th}>Compatibility</th><th className={th}>Validated</th><th className={th}>Certified</th><th className={th}>Activated</th><th className={th}>Action</th></tr></thead>
            <tbody>
              {detail.contracts.map((c) => {
                const current = c.id === reg.current_contract_id;
                const certify: ActionSpec = {
                  key: `certify-${c.id}`,
                  title: `Confirm certify of contract revision ${c.revision}`,
                  action: `POST ${base}/contracts/${c.id}/certify`,
                  requirements: ["Permission integration.certify and an evidence reference.", "Two-person rule: someone other than whoever validated this contract."],
                  fields: [evidenceField(true)],
                  confirmLabel: "Certify contract",
                  permission: "integration.certify",
                  run: (values) => svc.certifyContract(reg.id, c.id, { evidence_ref: values.evidence_ref }),
                  success: () => `Contract revision ${c.revision} certified. Someone other than you must activate it.`,
                };
                const activate: ActionSpec = {
                  key: `activate-${c.id}`,
                  title: `Confirm activate of contract revision ${c.revision}`,
                  action: `POST ${base}/contracts/${c.id}/activate · expected revision ${reg.revision}`,
                  requirements: ["Permission integration.approve.", "Two-person rule: someone other than the certifier.", "Re-compared with the contract active now; anything no longer purely additive is refused."],
                  fields: [],
                  confirmLabel: "Activate contract",
                  permission: "integration.approve",
                  run: () => svc.activateContract(reg.id, c.id, { expected_revision: reg.revision }),
                  success: () => `Contract revision ${c.revision} is now active.`,
                };
                return (
                  <tr key={c.id} className="border-b border-border/50">
                    <td className={td}>{c.revision}{current && <span className="ml-1 text-[10px] text-muted-foreground">(in force)</span>}</td>
                    <td className={td}><StatusPill value={c.status} /></td>
                    <td className={td}>{c.compatibility?.decision ?? "—"}</td>
                    <td className={td}>{c.validated_by ?? "—"}<span className="block text-[10px] text-muted-foreground">{when(c.validated_at)}</span></td>
                    <td className={td}>{c.certified_by ?? "—"}{c.certification_evidence_ref && <span className="block break-all font-mono text-[10px] text-muted-foreground">{c.certification_evidence_ref}</span>}</td>
                    <td className={td}>{when(c.activated_at)}</td>
                    <td className={td}>
                      {c.status === "VALIDATED" && enabled && (
                        <ActionButton label="Certify" ariaLabel={`Certify contract revision ${c.revision}`} variant="primary" disabledReason={blockFor("integration.certify", me && c.validated_by === me ? "Two-person rule: you validated this contract." : null)} onClick={() => open(certify)} />
                      )}
                      {c.status === "CERTIFIED" && enabled && (
                        <ActionButton label="Activate" ariaLabel={`Activate contract revision ${c.revision}`} variant="primary" disabledReason={blockFor("integration.approve", me && c.certified_by === me ? "Two-person rule: you certified this contract." : null)} onClick={() => open(activate)} />
                      )}
                      {!(enabled && (c.status === "VALIDATED" || c.status === "CERTIFIED")) && (
                        <span className="text-[11px] text-muted-foreground">{!enabled && (c.status === "VALIDATED" || c.status === "CERTIFIED") ? "Handled by the onboarding steps" : "—"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── History ───────────────────────────────────────────────────────

function HistoryCard({ detail }: { detail: Detail }) {
  const rows = [...detail.history].reverse();
  return (
    <Card title="Approval history" description="Append-only record of every decision (newest first).">
      {rows.length === 0 ? (
        <p className="font-poppins text-[12px] text-muted-foreground">No decisions recorded.</p>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full min-w-[720px]">
            <caption className="sr-only">Approval history</caption>
            <thead><tr className="border-b border-border"><th className={th}>When</th><th className={th}>Decision</th><th className={th}>Change</th><th className={th}>Actor</th><th className={th}>Reason / evidence</th><th className={th}>Revision</th></tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={String(h.id)} className="border-b border-border/50">
                  <td className={td}>{when(h.created_at)}</td>
                  <td className={td}><span className="font-mono text-[11px]">{h.decision}</span></td>
                  <td className={td}>{h.from_status || h.to_status ? `${h.from_status ?? "—"} → ${h.to_status ?? "—"}` : "—"}</td>
                  <td className={td}>{h.actor_id}</td>
                  <td className={td}><span className="break-all font-mono text-[10px]">{[h.reason_code, h.evidence_ref].filter(Boolean).join(" · ") || "—"}</span></td>
                  <td className={td}>{h.resulting_revision ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
