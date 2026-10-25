"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const core = require("../src/shared/auth/mfa-core");
const { loadSessionConfig } = require("../src/shared/auth/session.config");
const { hasFreshVerifiedMfa } = require("../src/shared/auth/privileged-mfa");
const { hasRecentMfa } = require("../src/shared/middlewares/auth.middleware");
const { csrfTokenFor, verifyCsrfToken } = require("../src/shared/auth/session.service");

const key = () => crypto.randomBytes(32).toString("base64");

test("TOTP matches the RFC 6238 SHA-1 test vectors and rejects malformed codes", () => {
  const secret = Buffer.from("12345678901234567890");
  // RFC 6238 Appendix B (8-digit values; we use the last 6 digits).
  assert.equal(core.totpAt(secret, Math.floor(59 / 30)), "287082");
  assert.equal(core.totpAt(secret, Math.floor(1111111109 / 30)), "081804");
  assert.equal(core.totpAt(secret, Math.floor(1234567890 / 30)), "005924");
  const now = 1234567890 * 1000;
  assert.equal(core.matchTotp(secret, "005924", now), Math.floor(1234567890 / 30));
  for (const bad of ["", "12345", "1234567", "abcdef", null]) assert.equal(core.matchTotp(secret, bad, now), null);
  assert.equal(core.matchTotp(secret, core.totpAt(secret, Math.floor(1234567890 / 30) + 2), now), null, "outside the +/-1 window");
});

test("base32 round-trips and otpauth URIs are well formed", () => {
  const secret = core.generateSecret();
  assert.equal(secret.length, 20);
  assert.ok(core.decodeBase32(core.encodeBase32(secret)).equals(secret));
  assert.equal(core.decodeBase32("not base32!"), null);
  const uri = new URL(core.otpauthUri({ secretBase32: "JBSWY3DPEHPK3PXP", accountName: "a@b.co" }));
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.searchParams.get("secret"), "JBSWY3DPEHPK3PXP");
  assert.equal(uri.searchParams.get("digits"), "6");
});

test("MFA secrets are AES-256-GCM encrypted, bound to the user, rotatable and fail closed", () => {
  const k1 = key();
  const k2 = key();
  const env1 = { AUTH_MFA_ENCRYPTION_KEYS: `k1:${k1}` };
  const secret = core.generateSecret();
  const envelope = core.encryptSecret(secret, "user-1", env1);
  assert.ok(envelope.startsWith("cfmfa1:k1:"));
  assert.ok(!envelope.includes(core.encodeBase32(secret)));
  assert.ok(core.decryptSecret(envelope, "user-1", env1).equals(secret));
  assert.throws(() => core.decryptSecret(envelope, "user-2", env1), "ciphertext cannot be moved to another user");
  const tampered = envelope.slice(0, -4) + (envelope.endsWith("A") ? "BBBB" : "AAAA");
  assert.throws(() => core.decryptSecret(tampered, "user-1", env1));
  // Rotation: new active key, old enrollments still decrypt and are flagged for rewrap.
  const env2 = { AUTH_MFA_ENCRYPTION_KEYS: `k1:${k1},k2:${k2}`, AUTH_MFA_ENCRYPTION_ACTIVE_KEY: "k2" };
  assert.ok(core.decryptSecret(envelope, "user-1", env2).equals(secret));
  assert.equal(core.needsRewrap(envelope, env2), true);
  assert.ok(core.encryptSecret(secret, "user-1", env2).startsWith("cfmfa1:k2:"));
  // Fail closed.
  assert.throws(() => core.encryptSecret(secret, "user-1", {}), (error) => error.code === "MFA_UNAVAILABLE" && error.statusCode === 503);
  assert.throws(() => core.decryptSecret(envelope, "user-1", { AUTH_MFA_ENCRYPTION_KEYS: `k2:${k2}` }), (error) => error.code === "MFA_UNAVAILABLE");
  assert.equal(core.loadKeyring({ AUTH_MFA_ENCRYPTION_KEYS: "k1:dG9vLXNob3J0" }).available, false, "short keys are ignored");
});

test("only verified enrollments count; twoFactorEnabled alone never does", () => {
  const env = { AUTH_MFA_ENCRYPTION_KEYS: `k1:${key()}` };
  const legacyUser = { id: "u", twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP" };
  assert.equal(core.isMfaEnrolled(null), false);
  assert.equal(core.isMfaEnrolled({ adminUserId: "u", enrolledAt: null, secretEncrypted: "x" }), false, "pending is not enrolled");
  assert.equal(core.resolveTotpSecret({ enrollment: null, user: legacyUser }, { env }), null);
  assert.ok(core.resolveTotpSecret({ enrollment: null, user: legacyUser }, { env, allowLegacyPlaintext: true }), "explicit opt-in for staged migrations only");
  const secret = core.generateSecret();
  const enrollment = { adminUserId: "u", enrolledAt: new Date(), secretEncrypted: core.encryptSecret(secret, "u", env) };
  assert.equal(core.isMfaEnrolled(enrollment), true);
  assert.ok(core.resolveTotpSecret({ enrollment }, { env }).equals(secret));
});

test("recovery codes are random, normalised and salted-hashed", () => {
  const codes = new Set(Array.from({ length: 200 }, () => core.generateRecoveryCode()));
  assert.equal(codes.size, 200);
  const code = [...codes][0];
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.ok(core.looksLikeRecoveryCode(code.toLowerCase().replace("-", " ")));
  assert.equal(core.looksLikeRecoveryCode("123456"), false);
  const a = core.hashRecoveryCode(code, "salt-a");
  assert.equal(a, core.hashRecoveryCode(code.toLowerCase(), "salt-a"));
  assert.notEqual(a, core.hashRecoveryCode(code, "salt-b"));
});

test("session configuration: safe defaults, cookie prefixes and SameSite rules", () => {
  const legacy = loadSessionConfig({});
  assert.equal(legacy.mode, "legacy");
  assert.equal(legacy.cookiesEnabled, false);
  assert.equal(legacy.accessTokenTtlSeconds, 8 * 3600, "legacy keeps the 8h token");
  assert.equal(loadSessionConfig({ AUTH_SESSION_MODE: "bogus" }).mode, "legacy", "unknown modes fall back safely");
  const dual = loadSessionConfig({ AUTH_SESSION_MODE: "dual", NODE_ENV: "production" });
  assert.equal(dual.accessTokenTtlSeconds, 900);
  assert.equal(dual.cookie.sameSite, "none");
  assert.equal(dual.cookie.secure, true);
  assert.equal(dual.cookie.accessName, "__Host-cf_at");
  assert.equal(dual.cookie.refreshName, "__Secure-cf_rt");
  assert.equal(dual.bodyTokenEnabled && dual.bearerAccepted, true);
  const cookie = loadSessionConfig({ AUTH_SESSION_MODE: "cookie", AUTH_COOKIE_SAMESITE: "lax", AUTH_COOKIE_SECURE: "false" });
  assert.equal(cookie.bodyTokenEnabled || cookie.bearerAccepted, false);
  assert.equal(cookie.cookie.accessName, "cf_at", "no prefix without Secure");
  assert.equal(loadSessionConfig({ AUTH_SESSION_MODE: "cookie", AUTH_COOKIE_SAMESITE: "none", AUTH_COOKIE_SECURE: "false" }).cookie.secure, true, "SameSite=None always forces Secure");
  const withDomain = loadSessionConfig({ AUTH_SESSION_MODE: "cookie", NODE_ENV: "production", AUTH_COOKIE_SAMESITE: "lax", AUTH_COOKIE_DOMAIN: ".cosmiforgegroup.cloud" });
  assert.equal(withDomain.cookie.accessName, "__Secure-cf_at", "__Host- cannot carry a Domain");
  assert.equal(loadSessionConfig({ AUTH_SESSION_MODE: "dual", AUTH_ACCESS_TOKEN_TTL_SECONDS: "5" }).accessTokenTtlSeconds, 60, "TTL is clamped");
  const degraded = loadSessionConfig({ AUTH_SESSION_MODE: "cookie", NODE_ENV: "production" }, { schemaReady: false });
  assert.equal(degraded.mode, "legacy", "dual/cookie fall back to legacy until the schema is migrated");
  assert.equal(degraded.degradedFrom, "cookie");
  assert.equal(degraded.cookiesEnabled || degraded.sessionsEnabled, false);
  assert.equal(degraded.accessTokenTtlSeconds, 8 * 3600);
});

test("CSRF tokens are per-session, derived and constant-time verified", () => {
  const env = { ADMIN_JWT_SECRET: "secret-one" };
  const session = { id: "s1", csrfNonce: "nonce-1" };
  const token = csrfTokenFor(session, env);
  assert.equal(verifyCsrfToken(session, token, env), true);
  assert.equal(verifyCsrfToken({ ...session, id: "s2" }, token, env), false);
  assert.equal(verifyCsrfToken({ ...session, csrfNonce: "nonce-2" }, token, env), false);
  assert.equal(verifyCsrfToken(session, token, { ADMIN_JWT_SECRET: "secret-two" }), false);
  assert.equal(verifyCsrfToken(session, undefined, env), false);
  assert.equal(verifyCsrfToken(session, token.slice(1), env), false);
});

test("fresh step-up evidence: session-bound, enrolled, at most 5 minutes old", () => {
  const now = Date.now();
  const mfa = { enrolled: true, sessionId: "s1", verifiedAt: new Date(now - 60_000).toISOString() };
  assert.equal(hasFreshVerifiedMfa({ mfa }, { now }), true);
  assert.equal(hasFreshVerifiedMfa({ twoFactorEnabled: true }, { now }), false);
  assert.equal(hasFreshVerifiedMfa({ mfa: { ...mfa, enrolled: false } }, { now }), false);
  assert.equal(hasFreshVerifiedMfa({ mfa: { ...mfa, sessionId: null } }, { now }), false);
  assert.equal(hasFreshVerifiedMfa({ mfa: { ...mfa, verifiedAt: new Date(now - 6 * 60_000).toISOString() } }, { now }), false);
  assert.equal(hasFreshVerifiedMfa({ mfa: { ...mfa, verifiedAt: new Date(now + 60_000).toISOString() } }, { now }), false, "future timestamps are rejected");
  assert.equal(hasRecentMfa({ id: "s1", mfaVerifiedAt: new Date(now - 1000) }, 5 * 60_000, now), true);
  assert.equal(hasRecentMfa({ id: null, mfaVerifiedAt: new Date(now - 1000) }, 5 * 60_000, now), false, "legacy tokens without a session never qualify");
});

test("schema readiness: cached once ready, rechecked while missing, fails safe on errors", async () => {
  const { createSchemaReadiness, AUTH_TABLES } = require("../src/shared/auth/schema-readiness");
  let present = false;
  let calls = 0;
  let clock = 0;
  const client = { $queryRawUnsafe: async (sql) => { calls += 1; assert.ok(AUTH_TABLES.every((t) => sql.includes(`'public.${t}'`))); return [Object.fromEntries(AUTH_TABLES.map((_, i) => [`t${i}`, present]))]; } };
  const warnings = [];
  const probe = createSchemaReadiness({ client, logger: { warn: (m) => warnings.push(m), info: () => {} }, recheckMs: 1000, now: () => clock });
  assert.equal(await probe.isReady(), false);
  assert.equal(await probe.isReady(), false);
  assert.equal(calls, 1, "a negative result is cached for recheckMs");
  assert.equal(warnings.length, 1, "warns loudly once");
  present = true;
  clock = 1500;
  assert.equal(await probe.isReady(), true, "picks up the migration without a restart");
  present = false;
  assert.equal(await probe.isReady(), true, "ready is sticky for the process");
  assert.equal(calls, 2);
  const broken = createSchemaReadiness({ client: { $queryRawUnsafe: async () => { throw new Error("db down"); } } });
  assert.equal(await broken.isReady(), false);
  const partial = createSchemaReadiness({ client: { $queryRawUnsafe: async () => [{ t0: true, t1: true }] } });
  assert.equal(await partial.isReady(), false, "every table must exist");
});
