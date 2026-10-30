"use strict";

const { createPublicKey, sign, verify } = require("node:crypto");
const P = require("./protocol");
const { canonicalize, digestOf } = require("./canonical");
const { compile } = require("./validator");
const { signedManifest, manifestBody } = require("./schemas");
const { catalogDigest, catalogErrors } = require("./catalog");

const validateSigned = compile(signedManifest);
const validateBody = compile(manifestBody);
const DEFAULT_MAX_VALIDITY_SECONDS = 7 * 24 * 3600;
const SKEW_MS = 60 * 1000;

class ManifestError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = "ManifestError";
    this.reason = reason;
    this.detail = detail;
  }
}

function toPublicKey(value) {
  if (!value) return null;
  if (typeof value === "object" && value.type === "public") return value;
  return createPublicKey(value);
}

// Signs the canonical manifest body with an Ed25519 private key. The key is
// held only by the Product Admin; HQ verifies with an operator-enrolled
// public key and never trusts a key carried in the manifest itself.
function signManifest(manifest, { privateKey, kid }) {
  const body = { ...manifest, signing_key_id: kid };
  const shape = validateBody(body);
  if (!shape.valid) throw new ManifestError("MANIFEST_SCHEMA_INVALID", shape.errors.slice(0, 5));
  const errors = catalogErrors(body);
  if (errors.length) throw new ManifestError("CATALOG_INVALID", errors.slice(0, 10));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new ManifestError("SIGNING_KEY_NOT_ED25519");
  const value = sign(null, Buffer.from(canonicalize(body)), privateKey).toString("base64url");
  return {
    manifest: body,
    signature: { alg: "EdDSA", kid, signed_revision: body.manifest_revision, signed_digest: digestOf(body), value },
  };
}

function verifyManifest(signed, { trustStore, expected, now = Date.now(), maxValiditySeconds = DEFAULT_MAX_VALIDITY_SECONDS, supported = P.PROTOCOL_VERSION } = {}) {
  if (!expected || !expected.productId || !expected.environment || !expected.signerKid) {
    throw new ManifestError("EXPECTATIONS_REQUIRED");
  }
  const shape = validateSigned(signed);
  if (!shape.valid) throw new ManifestError("MANIFEST_SCHEMA_INVALID", shape.errors.slice(0, 5));
  const { manifest, signature } = signed;

  // Signer: must be the registry-approved key ID and enrolled for this
  // exact product and environment.
  if (signature.kid !== expected.signerKid || manifest.signing_key_id !== signature.kid) throw new ManifestError("SIGNER_NOT_APPROVED");
  const entry = trustStore && Object.prototype.hasOwnProperty.call(trustStore, signature.kid) ? trustStore[signature.kid] : null;
  if (!entry) throw new ManifestError("SIGNER_UNKNOWN");
  if (entry.revoked) throw new ManifestError("SIGNER_REVOKED");
  const notAfter = typeof entry.notAfter === "number" ? entry.notAfter : Date.parse(entry.notAfter);
  if (!Number.isFinite(notAfter) || notAfter <= now) throw new ManifestError("SIGNER_EXPIRED");
  if (entry.productId !== expected.productId || entry.environment !== expected.environment) throw new ManifestError("SIGNER_SCOPE_MISMATCH");

  let publicKey;
  try { publicKey = toPublicKey(entry.publicKey); } catch { throw new ManifestError("SIGNER_KEY_INVALID"); }
  if (!publicKey || publicKey.asymmetricKeyType !== "ed25519") throw new ManifestError("SIGNER_KEY_INVALID");
  const signedBytes = Buffer.from(canonicalize(manifest));
  let ok = false;
  try { ok = verify(null, signedBytes, publicKey, Buffer.from(signature.value, "base64url")); } catch { ok = false; }
  if (!ok) throw new ManifestError("SIGNATURE_INVALID");
  const manifestDigest = digestOf(manifest);
  if (signature.signed_digest !== manifestDigest) throw new ManifestError("DIGEST_MISMATCH");
  if (signature.signed_revision !== manifest.manifest_revision) throw new ManifestError("REVISION_MISMATCH");

  // Identity: the manifest proposes nothing about who it is; it must match
  // what the registry already approved.
  if (manifest.product_id !== expected.productId) throw new ManifestError("PRODUCT_MISMATCH");
  if (expected.serviceInstanceId && manifest.service_instance_id !== expected.serviceInstanceId) throw new ManifestError("INSTANCE_MISMATCH");
  if (manifest.environment !== expected.environment) throw new ManifestError("ENVIRONMENT_MISMATCH");
  if (expected.workloadIdentity && manifest.workload_identity !== expected.workloadIdentity) throw new ManifestError("WORKLOAD_IDENTITY_MISMATCH");

  const issued = Date.parse(manifest.issued_at);
  const expires = Date.parse(manifest.expires_at);
  if (issued > now + SKEW_MS) throw new ManifestError("MANIFEST_NOT_YET_VALID");
  if (expires <= now) throw new ManifestError("MANIFEST_EXPIRED");
  if (expires <= issued || expires - issued > maxValiditySeconds * 1000) throw new ManifestError("MANIFEST_VALIDITY_INVALID");
  if (!P.isSupportedProtocol(manifest.protocol, supported)) throw new ManifestError("PROTOCOL_UNSUPPORTED");
  if (expected.minimumRevision && manifest.manifest_revision < expected.minimumRevision) throw new ManifestError("REVISION_ROLLBACK");

  const errors = catalogErrors(manifest);
  if (errors.length) throw new ManifestError("CATALOG_INVALID", errors.slice(0, 10));

  return { manifest, manifestDigest, catalogDigest: catalogDigest(manifest), expiresAt: manifest.expires_at };
}

module.exports = { ManifestError, signManifest, verifyManifest, toPublicKey };
