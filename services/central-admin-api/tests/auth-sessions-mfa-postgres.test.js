"use strict";

// HQ secure sessions + MFA on real PostgreSQL through the real Express app.
// Requires DATABASE_URL pointing at a disposable Admin DB with the current
// schema (CI: prisma db push). No network access beyond 127.0.0.1.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const MFA_KEY = crypto.randomBytes(32).toString("base64");
Object.assign(process.env, {
  NODE_ENV: "test",
  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET || "test-admin-jwt-secret-for-sessions",
  CORS_ORIGINS: "http://localhost:3000",
  AUTH_MFA_ENCRYPTION_KEYS: `k1:${MFA_KEY}`,
  AUTH_SESSION_MODE: "legacy",
});

const { createApp } = require("../src/app");
const { prisma } = require("../src/shared/config/database");
const { hashPassword } = require("../src/shared/utils/password.util");
const core = require("../src/shared/auth/mfa-core");
const jwt = require("jsonwebtoken");
const authController = require("../src/modules/auth/auth.controller");
const { closeServer } = require("./helpers/server-close");

const PASSWORD = "Correct-Horse-9!";
const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomBytes(4).toString("hex");

function setMode(mode, extra = {}) {
  process.env.AUTH_SESSION_MODE = mode;
  for (const key of ["AUTH_REFRESH_REUSE_GRACE_SECONDS", "AUTH_MAX_SESSIONS_PER_USER"]) delete process.env[key];
  Object.assign(process.env, extra);
}

function parseSetCookie(header) {
  const [pair, ...attrs] = header.split(";").map((part) => part.trim());
  const index = pair.indexOf("=");
  const attributes = {};
  for (const attr of attrs) {
    const [k, v = true] = attr.split("=");
    attributes[k.toLowerCase()] = v;
  }
  return { name: pair.slice(0, index), value: decodeURIComponent(pair.slice(index + 1)), attributes };
}

function agent(base) {
  const jar = new Map();
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const state = { csrf: null, bearer: null, lastSetCookies: [] };
  async function request(method, path, { body, headers = {}, csrf, bearer, origin = ORIGIN, cookies = true } = {}) {
    const h = { "x-forwarded-for": ip, ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (origin) h.origin = origin;
    if (cookies && jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    const csrfToken = csrf === undefined ? state.csrf : csrf;
    if (csrfToken) h["x-csrf-token"] = csrfToken;
    const token = bearer === undefined ? state.bearer : bearer;
    if (token) h.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookies = res.headers.getSetCookie().map(parseSetCookie);
    state.lastSetCookies = setCookies;
    for (const cookie of setCookies) {
      const expired = cookie.attributes["max-age"] === "0" || (cookie.attributes.expires && new Date(cookie.attributes.expires) < new Date()) || cookie.value === "";
      if (expired) jar.delete(cookie.name);
      else jar.set(cookie.name, cookie.value);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, setCookies, code: json?.code };
  }
  return { jar, state, request };
}

async function seedUser(key, data = {}) {
  return prisma.adminUser.create({
    data: {
      email: `${key}-${RUN}@cosmicforge.test`,
      name: `${key} ${RUN}`,
      password: await hashPassword(PASSWORD),
      status: "ACTIVE",
      mustChangePassword: false,
      tier: "EMPLOYEE",
      ...data,
    },
  });
}

const sessionOf = (token) => jwt.decode(token)?.sid;
const codeFor = (secretBase32, offsetSteps = 0) => core.totpAt(core.decodeBase32(secretBase32), core.currentStep() + offsetSteps);
// Test-only: forget the replay watermark so the next code in the same 30 s window is usable.
const allowNextCode = (userId) => prisma.adminUser.update({ where: { id: userId }, data: { mfaLastUsedStep: null } });

test("HQ sessions and MFA on real PostgreSQL", { timeout: 240000 }, async (t) => {
  const app = createApp({ env: process.env });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const users = {};
  try {
    users.alice = await seedUser("alice");
    users.bob = await seedUser("bob");
    users.carol = await seedUser("carol");
    users.hr = await seedUser("hr", { tier: "ADMIN", department: "MANAGEMENT", isTeamLead: true });
    users.employee = await seedUser("employee");
    users.superUser = await seedUser("super", { tier: "SUPER" });
    users.legacy2fa = await seedUser("legacy2fa", { twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP" });

    const login = async (a, user, password = PASSWORD) => a.request("POST", "/api/auth/login", { body: { email: user.email, password } });

    await t.test("legacy mode keeps the existing contract and still tracks a server-side session", async () => {
      setMode("legacy");
      const a = agent(base);
      const res = await login(a, users.alice);
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.data.accessToken, "body token returned");
      assert.equal(res.body.data.csrfToken, undefined);
      assert.ok(a.jar.has("refreshToken") && a.jar.has("isLoggedIn"), "legacy cookies unchanged");
      assert.ok(!a.jar.has("cf_at") && !a.jar.has("cf_rt"), "no session cookies in legacy mode");
      const sid = sessionOf(res.body.data.accessToken);
      assert.ok(sid, "access token carries a session id");
      assert.ok(await prisma.adminSession.findUnique({ where: { id: sid } }));
      a.state.bearer = res.body.data.accessToken;
      const me = await a.request("GET", "/api/auth/me");
      assert.equal(me.status, 200);
      assert.equal(me.body.data.email, users.alice.email);
      assert.deepEqual(Object.keys(me.body.data).sort(), ["department", "email", "id", "isTeamLead", "mainAppUserId", "mustChangePassword", "name", "passwordChangedAt", "status", "tier", "twoFactorEnabled"].sort(), "req.adminUser shape is unchanged");
      // A token without a session (minted before this release) is still honoured until expiry.
      const preRelease = jwt.sign({ sub: users.alice.id, email: users.alice.email, tier: "EMPLOYEE" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h", issuer: "cosmicforge-admin", audience: "cosmicforge-admin-client" });
      assert.equal((await a.request("GET", "/api/auth/me", { bearer: preRelease })).status, 200);
      const refreshed = await a.request("POST", "/api/auth/refresh-token");
      assert.equal(refreshed.status, 200, refreshed.text);
      assert.equal(sessionOf(refreshed.body.data.accessToken), sid, "refresh stays in the same session family");
    });

    await t.test("refresh rotation: concurrent use is a soft race, later reuse revokes the whole session", async () => {
      setMode("legacy");
      const a = agent(base);
      const res = await login(a, users.alice);
      const sid = sessionOf(res.body.data.accessToken);
      const oldRefresh = a.jar.get("refreshToken");
      assert.equal((await a.request("POST", "/api/auth/refresh-token")).status, 200);
      const raced = await a.request("POST", "/api/auth/refresh-token", { headers: { cookie: `refreshToken=${encodeURIComponent(oldRefresh)}` }, cookies: false });
      assert.equal(raced.status, 401);
      assert.equal(raced.code, "AUTH_REFRESH_RACE");
      assert.equal((await prisma.adminSession.findUnique({ where: { id: sid } })).revokedAt, null, "a race does not log the user out");

      setMode("legacy", { AUTH_REFRESH_REUSE_GRACE_SECONDS: "0" });
      const reused = await a.request("POST", "/api/auth/refresh-token", { headers: { cookie: `refreshToken=${encodeURIComponent(oldRefresh)}` }, cookies: false });
      assert.equal(reused.code, "AUTH_REFRESH_REUSED");
      const session = await prisma.adminSession.findUnique({ where: { id: sid } });
      assert.equal(session.revokeReason, "REFRESH_TOKEN_REUSE");
      assert.equal((await a.request("POST", "/api/auth/refresh-token")).status, 401, "the current refresh token of the family is dead too");
      assert.equal((await a.request("GET", "/api/auth/me", { bearer: res.body.data.accessToken })).code, "AUTH_SESSION_REVOKED", "access tokens of the family stop working at once");
      assert.ok(await prisma.auditLog.count({ where: { action: "REFRESH_TOKEN_REUSE_DETECTED", targetId: sid } }));
    });

    await t.test("dual mode: httpOnly cookies + CSRF, body token and Bearer still accepted", async () => {
      setMode("dual");
      const a = agent(base);
      const res = await login(a, users.bob);
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.data.accessToken && res.body.data.csrfToken);
      const access = res.setCookies.find((c) => c.name === "cf_at");
      const refresh = res.setCookies.find((c) => c.name === "cf_rt");
      assert.ok(access.attributes.httponly && refresh.attributes.httponly);
      assert.equal(access.attributes.path, "/");
      assert.equal(refresh.attributes.path, "/api/auth", "refresh cookie only travels to the auth endpoints");
      assert.equal(String(access.attributes.samesite).toLowerCase(), "lax");
      assert.ok(Number(access.attributes["max-age"]) <= 15 * 60, "short-lived access cookie");
      assert.ok(!a.jar.has("refreshToken"), "legacy refresh cookie is not issued in dual mode");
      a.state.csrf = res.body.data.csrfToken;

      assert.equal((await a.request("GET", "/api/auth/me")).status, 200, "cookie auth works for reads");
      const session = await a.request("GET", "/api/auth/session");
      assert.equal(session.body.data.csrfToken, res.body.data.csrfToken, "CSRF token can be re-fetched after a reload");

      // Unsafe cookie request: an endpoint that answers 400 once auth+CSRF pass.
      const probe = (opts) => a.request("POST", "/api/auth/mfa/step-up", { body: {}, ...opts });
      assert.equal((await probe({ csrf: null })).code, "AUTH_CSRF_INVALID");
      assert.equal((await probe({ csrf: "forged-token" })).code, "AUTH_CSRF_INVALID");
      const evil = await probe({ origin: "https://evil.example" });
      assert.ok(![200, 400].includes(evil.status), "a foreign Origin never reaches the handler (CORS rejects it first)");
      assert.equal((await probe({ origin: null })).code, "AUTH_ORIGIN_REJECTED", "no Origin and no Referer is refused");
      assert.equal((await probe({ origin: null, headers: { referer: `${ORIGIN}/dashboard` } })).status, 400, "Referer from the frontend is accepted");
      assert.equal((await probe({})).status, 400, "valid CSRF + Origin reaches the handler");
      assert.equal((await probe({ csrf: null, cookies: false, bearer: res.body.data.accessToken, origin: null })).status, 400, "Bearer requests are exempt from CSRF");
      assert.ok(await prisma.auditLog.count({ where: { action: "CSRF_REJECTED", adminUserId: users.bob.id } }));

      const refreshed = await a.request("POST", "/api/auth/refresh-token");
      assert.equal(refreshed.status, 200, refreshed.text);
      assert.equal(refreshed.body.data.csrfToken, res.body.data.csrfToken, "CSRF token is stable per session");
      assert.equal((await a.request("POST", "/api/auth/refresh-token", { origin: null })).code, "AUTH_ORIGIN_REJECTED", "cookie refresh without a trusted Origin is refused");
      assert.ok(![200].includes((await a.request("POST", "/api/auth/refresh-token", { origin: "https://evil.example" })).status), "cross-site refresh is refused");
    });

    await t.test("cookie mode: no token in bodies, Bearer refused, legacy tokens refused", async () => {
      setMode("dual");
      const dual = agent(base);
      const dualLogin = await login(dual, users.carol);
      setMode("cookie");
      const a = agent(base);
      const res = await login(a, users.carol);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.accessToken, undefined, "no token in the body");
      assert.ok(res.body.data.csrfToken);
      assert.equal((await a.request("GET", "/api/auth/me")).status, 200);
      assert.equal((await a.request("GET", "/api/auth/me", { cookies: false, bearer: dualLogin.body.data.accessToken })).code, "AUTH_BEARER_DISABLED");
      const refreshed = await a.request("POST", "/api/auth/refresh-token", { csrf: res.body.data.csrfToken });
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.body.data.accessToken, undefined);
      const preRelease = jwt.sign({ sub: users.carol.id }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h", issuer: "cosmicforge-admin", audience: "cosmicforge-admin-client" });
      assert.equal((await a.request("GET", "/api/auth/me", { headers: { cookie: `cf_at=${preRelease}` }, cookies: false })).code, "AUTH_SESSION_INVALID");
    });

    await t.test("logout, logout-all, listing and revoking own sessions", async () => {
      setMode("dual");
      const one = agent(base);
      const two = agent(base);
      const r1 = await login(one, users.alice);
      const r2 = await login(two, users.alice);
      one.state.csrf = r1.body.data.csrfToken;
      two.state.csrf = r2.body.data.csrfToken;
      const listed = await one.request("GET", "/api/auth/sessions");
      const ids = listed.body.data.map((s) => s.id);
      assert.ok(ids.includes(r1.body.data.session.id) && ids.includes(r2.body.data.session.id));
      assert.equal(listed.body.data.find((s) => s.id === r1.body.data.session.id).current, true);
      assert.equal((await one.request("DELETE", `/api/auth/sessions/${r2.body.data.session.id}`)).status, 200);
      assert.equal((await two.request("GET", "/api/auth/me")).code, "AUTH_SESSION_REVOKED");
      assert.equal((await one.request("DELETE", `/api/auth/sessions/${crypto.randomUUID()}`)).status, 404, "cannot revoke sessions you do not own");

      const logout = await one.request("POST", "/api/auth/logout");
      assert.equal(logout.status, 200);
      assert.ok(!one.jar.has("cf_at") && !one.jar.has("cf_rt"), "cookies cleared");
      assert.equal((await prisma.adminSession.findUnique({ where: { id: r1.body.data.session.id } })).revokeReason, "LOGOUT");
      assert.equal((await one.request("GET", "/api/auth/me", { headers: { cookie: `cf_at=${r1.body.data.accessToken}` }, cookies: false })).code, "AUTH_SESSION_REVOKED", "a copied access cookie dies with the session");

      const three = agent(base);
      const four = agent(base);
      const r3 = await login(three, users.alice);
      await login(four, users.alice);
      three.state.csrf = r3.body.data.csrfToken;
      assert.equal((await three.request("POST", "/api/auth/logout-all")).status, 200);
      assert.equal((await four.request("GET", "/api/auth/me")).status, 401);
      assert.equal((await three.request("GET", "/api/auth/me")).status, 401);
    });

    await t.test("idle and absolute expiry end the session", async () => {
      setMode("dual");
      const a = agent(base);
      const res = await login(a, users.bob);
      const sid = res.body.data.session.id;
      await prisma.adminSession.update({ where: { id: sid }, data: { idleExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await a.request("GET", "/api/auth/me")).code, "AUTH_SESSION_EXPIRED");
      assert.equal((await a.request("POST", "/api/auth/refresh-token")).code, "AUTH_SESSION_EXPIRED", "an idle-expired session cannot be refreshed");
      const b = agent(base);
      const r2 = await login(b, users.bob);
      await prisma.adminSession.update({ where: { id: r2.body.data.session.id }, data: { absoluteExpiresAt: new Date(Date.now() - 1000), idleExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await b.request("POST", "/api/auth/refresh-token")).status, 401);
    });

    await t.test("concurrent sessions are capped (oldest revoked)", async () => {
      setMode("dual", { AUTH_MAX_SESSIONS_PER_USER: "2" });
      const agents = [agent(base), agent(base), agent(base)];
      const results = [];
      for (const a of agents) results.push(await login(a, users.carol));
      const first = await prisma.adminSession.findUnique({ where: { id: results[0].body.data.session.id } });
      assert.equal(first.revokeReason, "SESSION_LIMIT");
      assert.equal((await agents[0].request("GET", "/api/auth/me")).status, 401);
      assert.equal((await agents[2].request("GET", "/api/auth/me")).status, 200);
    });

    await t.test("deactivated and locked accounts lose access immediately; password change ends sessions", async () => {
      setMode("dual");
      const a = agent(base);
      await login(a, users.employee);
      await prisma.adminUser.update({ where: { id: users.employee.id }, data: { status: "INACTIVE" } });
      assert.equal((await a.request("GET", "/api/auth/me")).status, 403);
      assert.equal((await a.request("POST", "/api/auth/refresh-token")).code, "AUTH_ACCOUNT_INACTIVE");
      await prisma.adminUser.update({ where: { id: users.employee.id }, data: { status: "LOCKED", lockedUntil: new Date(Date.now() + 60000) } });
      assert.equal((await a.request("GET", "/api/auth/me")).status, 403);
      await prisma.adminUser.update({ where: { id: users.employee.id }, data: { status: "ACTIVE", lockedUntil: null } });

      const b = agent(base);
      const other = agent(base);
      const res = await login(b, users.employee);
      await login(other, users.employee);
      b.state.csrf = res.body.data.csrfToken;
      const changed = await b.request("POST", "/api/auth/change-password", { body: { currentPassword: PASSWORD, newPassword: "New-Password-42!", confirmPassword: "New-Password-42!" } });
      assert.equal(changed.status, 200, changed.text);
      assert.equal((await other.request("GET", "/api/auth/me")).status, 401, "other sessions end on password change");
      assert.equal((await b.request("GET", "/api/auth/me", { headers: { cookie: `cf_at=${res.body.data.accessToken}` }, cookies: false })).status, 401);
      await prisma.adminUser.update({ where: { id: users.employee.id }, data: { password: await hashPassword(PASSWORD) } });
    });

    await t.test("session fixation: every login mints a new server-chosen session", async () => {
      setMode("dual");
      const a = agent(base);
      const first = await login(a, users.bob);
      const second = await login(a, users.bob); // jar still holds the first session's cookies
      assert.notEqual(first.body.data.session.id, second.body.data.session.id);
      const forged = jwt.sign({ sub: users.bob.id, sid: first.body.data.session.id }, "attacker-secret", { issuer: "cosmicforge-admin", audience: "cosmicforge-admin-client" });
      assert.equal((await a.request("GET", "/api/auth/me", { headers: { cookie: `cf_at=${forged}` }, cookies: false })).status, 401);
      const crossUser = jwt.sign({ sub: users.alice.id, sid: first.body.data.session.id }, process.env.ADMIN_JWT_SECRET, { issuer: "cosmicforge-admin", audience: "cosmicforge-admin-client", expiresIn: "5m" });
      assert.equal((await a.request("GET", "/api/auth/me", { bearer: crossUser, cookies: false })).code, "AUTH_SESSION_INVALID", "a session cannot be borrowed by another user");
    });

    let aliceSecret;
    let aliceRecovery;
    await t.test("MFA enrollment requires the password, encrypts the secret and activates only after a valid code", async () => {
      setMode("dual");
      const a = agent(base);
      const res = await login(a, users.alice);
      a.state.csrf = res.body.data.csrfToken;
      assert.equal((await a.request("GET", "/api/auth/mfa/status")).body.data.enrolled, false);
      assert.equal((await a.request("POST", "/api/auth/mfa/enroll", { body: { password: "wrong" } })).code, "AUTH_PASSWORD_INVALID");

      const savedKeys = process.env.AUTH_MFA_ENCRYPTION_KEYS;
      delete process.env.AUTH_MFA_ENCRYPTION_KEYS;
      const unavailable = await a.request("POST", "/api/auth/mfa/enroll", { body: { password: PASSWORD } });
      process.env.AUTH_MFA_ENCRYPTION_KEYS = savedKeys;
      assert.equal(unavailable.status, 503, "fails closed without an encryption key");

      const enroll = await a.request("POST", "/api/auth/mfa/enroll", { body: { password: PASSWORD } });
      assert.equal(enroll.status, 200, enroll.text);
      aliceSecret = enroll.body.data.secret;
      assert.match(enroll.body.data.otpauthUri, /^otpauth:\/\/totp\//);
      const row = await prisma.adminUser.findUnique({ where: { id: users.alice.id } });
      assert.equal(row.mfaEnrolledAt, null, "not active before verification");
      assert.ok(row.mfaPendingSecretEncrypted.startsWith("cfmfa1:"));
      assert.ok(!JSON.stringify(row).includes(aliceSecret), "secret never stored in plaintext");
      assert.equal((await a.request("POST", "/api/auth/mfa/activate", { body: { code: "000000" } })).code, "MFA_CODE_INVALID");

      const activated = await a.request("POST", "/api/auth/mfa/activate", { body: { code: codeFor(aliceSecret) } });
      assert.equal(activated.status, 200, activated.text);
      aliceRecovery = activated.body.data.recoveryCodes;
      assert.equal(aliceRecovery.length, 10);
      const after = await prisma.adminUser.findUnique({ where: { id: users.alice.id } });
      assert.ok(after.mfaEnrolledAt && after.mfaSecretEncrypted && after.twoFactorEnabled);
      assert.equal(after.twoFactorSecret, null);
      const stored = await prisma.adminMfaRecoveryCode.findMany({ where: { adminUserId: users.alice.id } });
      assert.equal(stored.length, 10);
      for (const code of aliceRecovery) assert.ok(!JSON.stringify(stored).includes(code.replace("-", "")) && !JSON.stringify(stored).includes(code), "recovery codes stored hashed only");
      assert.ok(await prisma.auditLog.count({ where: { action: "MFA_ENROLLED", adminUserId: users.alice.id } }));
    });

    await t.test("MFA login challenge: no session before the second factor, replay and reuse refused", async () => {
      setMode("dual");
      const a = agent(base);
      const first = await login(a, users.alice);
      assert.equal(first.status, 200);
      assert.equal(first.body.data.mfaRequired, true);
      assert.equal(first.body.data.accessToken, undefined, "no token before the second factor");
      assert.ok(!first.setCookies.some((c) => ["cf_at", "cf_rt"].includes(c.name)), "no session cookies before the second factor");
      const challengeToken = first.body.data.challengeToken;
      assert.equal((await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken, code: "123456" } })).code, "MFA_CODE_INVALID");
      // The activation code's time-step was already used: replay is refused.
      const lastStep = (await prisma.adminUser.findUnique({ where: { id: users.alice.id } })).mfaLastUsedStep;
      const replay = core.totpAt(core.decodeBase32(aliceSecret), lastStep);
      assert.equal((await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken, code: replay } })).code, "MFA_CODE_INVALID", "TOTP replay refused");

      await allowNextCode(users.alice.id);
      const ok = await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken, code: codeFor(aliceSecret) } });
      assert.equal(ok.status, 200, ok.text);
      assert.ok(ok.body.data.session.mfaVerifiedAt, "session starts MFA-verified");
      assert.equal(ok.body.data.session.authMethod, "PASSWORD+MFA");
      await allowNextCode(users.alice.id);
      assert.equal((await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken, code: codeFor(aliceSecret) } })).code, "MFA_CHALLENGE_INVALID", "challenge is single use");

      const second = await login(agent(base), users.alice);
      await prisma.adminMfaChallenge.updateMany({ where: { tokenHash: crypto.createHash("sha256").update(second.body.data.challengeToken).digest("hex") }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await allowNextCode(users.alice.id);
      assert.equal((await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken: second.body.data.challengeToken, code: codeFor(aliceSecret) } })).code, "MFA_CHALLENGE_INVALID", "expired challenge refused");

      const third = await login(agent(base), users.alice);
      for (let i = 0; i < 4; i += 1) await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken: third.body.data.challengeToken, code: "000001" } });
      await prisma.adminUser.update({ where: { id: users.alice.id }, data: { mfaFailedAttempts: 0, mfaLockedUntil: null } });
      await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken: third.body.data.challengeToken, code: "000002" } });
      await allowNextCode(users.alice.id);
      await prisma.adminUser.update({ where: { id: users.alice.id }, data: { mfaFailedAttempts: 0, mfaLockedUntil: null } });
      assert.equal((await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken: third.body.data.challengeToken, code: codeFor(aliceSecret) } })).code, "MFA_CHALLENGE_INVALID", "challenge dies after 5 attempts");
    });

    await t.test("recovery codes work once; repeated failures lock MFA", async () => {
      setMode("dual");
      const a = agent(base);
      const res = await login(a, users.alice);
      const used = await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken: res.body.data.challengeToken, recoveryCode: aliceRecovery[0] } });
      assert.equal(used.status, 200, used.text);
      const again = await login(agent(base), users.alice);
      assert.equal((await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken: again.body.data.challengeToken, recoveryCode: aliceRecovery[0] } })).code, "MFA_CODE_INVALID", "recovery code is single use");
      assert.equal((await prisma.adminMfaRecoveryCode.count({ where: { adminUserId: users.alice.id, usedAt: null } })), 9);
      assert.ok(await prisma.auditLog.count({ where: { action: "MFA_RECOVERY_CODE_USED", adminUserId: users.alice.id } }));

      a.state.csrf = used.body.data.csrfToken;
      await prisma.adminUser.update({ where: { id: users.alice.id }, data: { mfaFailedAttempts: 0, mfaLockedUntil: null } });
      for (let i = 0; i < 5; i += 1) await a.request("POST", "/api/auth/mfa/step-up", { body: { code: "999999" } });
      const locked = await a.request("POST", "/api/auth/mfa/step-up", { body: { code: codeFor(aliceSecret, 1) } });
      assert.equal(locked.status, 429);
      assert.equal(locked.code, "MFA_LOCKED");
      assert.ok(await prisma.auditLog.count({ where: { action: "MFA_LOCKED", adminUserId: users.alice.id } }));
      await prisma.adminUser.update({ where: { id: users.alice.id }, data: { mfaFailedAttempts: 0, mfaLockedUntil: null } });
    });

    await t.test("privileged actions require a fresh step-up on the current session", async () => {
      setMode("dual");
      const a = agent(base);
      const res = await login(a, users.alice);
      await allowNextCode(users.alice.id);
      const done = await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken: res.body.data.challengeToken, code: codeFor(aliceSecret) } });
      assert.equal(done.status, 200, done.text);
      a.state.csrf = done.body.data.csrfToken;
      await prisma.adminSession.update({ where: { id: done.body.data.session.id }, data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60 * 1000) } });
      assert.equal((await a.request("POST", "/api/auth/mfa/recovery-codes/regenerate", { body: {} })).code, "MFA_STEP_UP_REQUIRED", "stale verification is not enough");
      await allowNextCode(users.alice.id);
      assert.equal((await a.request("POST", "/api/auth/mfa/step-up", { body: { code: codeFor(aliceSecret) } })).status, 200);
      const regenerated = await a.request("POST", "/api/auth/mfa/recovery-codes/regenerate", { body: {} });
      assert.equal(regenerated.status, 200, regenerated.text);
      const fresh = regenerated.body.data.recoveryCodes;
      const next = await login(agent(base), users.alice);
      assert.equal((await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken: next.body.data.challengeToken, recoveryCode: aliceRecovery[1] } })).code, "MFA_CODE_INVALID", "old recovery codes stop working");
      aliceRecovery = fresh;

      // Legacy flag without verified enrollment: logs in directly and can never step up.
      const legacy = agent(base);
      const legacyLogin = await login(legacy, users.legacy2fa);
      assert.equal(legacyLogin.body.data.mfaRequired, undefined, "twoFactorEnabled alone does not trigger a challenge");
      legacy.state.csrf = legacyLogin.body.data.csrfToken;
      assert.equal((await legacy.request("POST", "/api/auth/mfa/step-up", { body: { code: core.totpAt(core.decodeBase32("JBSWY3DPEHPK3PXP"), core.currentStep()) } })).code, "MFA_NOT_ENROLLED", "the legacy plaintext secret is not accepted");
      assert.equal((await legacy.request("POST", "/api/auth/mfa/recovery-codes/regenerate", { body: {} })).code, "MFA_STEP_UP_REQUIRED");
    });

    await t.test("admin-assisted reset needs an authorized actor with a fresh step-up", async () => {
      setMode("dual");
      // Enroll the HR admin.
      const hr = agent(base);
      const hrLogin = await login(hr, users.hr);
      hr.state.csrf = hrLogin.body.data.csrfToken;
      const enroll = await hr.request("POST", "/api/auth/mfa/enroll", { body: { password: PASSWORD } });
      const hrSecret = enroll.body.data.secret;
      assert.equal((await hr.request("POST", "/api/auth/mfa/activate", { body: { code: codeFor(hrSecret) } })).status, 200);
      const target = agent(base);
      const targetLogin = await login(target, users.alice);
      await allowNextCode(users.alice.id);
      await target.request("POST", "/api/auth/login/mfa", { body: { challengeToken: targetLogin.body.data.challengeToken, code: codeFor(aliceSecret) } });

      const employee = agent(base);
      const empLogin = await login(employee, users.bob);
      employee.state.csrf = empLogin.body.data.csrfToken;
      assert.equal((await employee.request("POST", "/api/auth/mfa/admin-reset", { body: { targetUserId: users.alice.id, reason: "Lost phone, verified by video call" } })).code, "MFA_STEP_UP_REQUIRED");

      await prisma.adminSession.update({ where: { id: hrLogin.body.data.session.id }, data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60 * 1000) } });
      assert.equal((await hr.request("POST", "/api/auth/mfa/admin-reset", { body: { targetUserId: users.alice.id, reason: "Lost phone, verified by video call" } })).code, "MFA_STEP_UP_REQUIRED");
      await allowNextCode(users.hr.id);
      assert.equal((await hr.request("POST", "/api/auth/mfa/step-up", { body: { code: codeFor(hrSecret) } })).status, 200);
      assert.equal((await hr.request("POST", "/api/auth/mfa/admin-reset", { body: { targetUserId: users.hr.id, reason: "Trying to reset myself here" } })).code, "MFA_RESET_SELF_FORBIDDEN");
      assert.equal((await hr.request("POST", "/api/auth/mfa/admin-reset", { body: { targetUserId: users.superUser.id, reason: "Not allowed for HR admins" } })).code, "MFA_RESET_FORBIDDEN");
      const reset = await hr.request("POST", "/api/auth/mfa/admin-reset", { body: { targetUserId: users.alice.id, reason: "Lost phone, verified by video call" } });
      assert.equal(reset.status, 200, reset.text);
      assert.equal(reset.body.data.wasEnrolled, true);
      assert.equal((await target.request("GET", "/api/auth/me")).status, 401, "target's sessions are revoked");
      const row = await prisma.adminUser.findUnique({ where: { id: users.alice.id } });
      assert.equal(row.mfaEnrolledAt, null);
      assert.equal(await prisma.adminMfaRecoveryCode.count({ where: { adminUserId: users.alice.id } }), 0);
      const audit = await prisma.auditLog.findFirst({ where: { action: "MFA_ADMIN_RESET", targetId: users.alice.id } });
      assert.equal(audit.adminUserId, users.hr.id);
      assert.ok(await prisma.notification.count({ where: { adminUserId: users.alice.id, title: "Two-factor authentication was reset" } }));
      assert.equal((await login(agent(base), users.alice)).body.data.mfaRequired, undefined, "after reset the user signs in with password only and must re-enroll");
    });

    await t.test("disabling MFA requires password + factor and ends other sessions", async () => {
      setMode("dual");
      const a = agent(base);
      const res = await login(a, users.hr);
      await allowNextCode(users.hr.id);
      const hrRow = await prisma.adminUser.findUnique({ where: { id: users.hr.id } });
      const hrSecret = core.encodeBase32(core.decryptSecret(hrRow.mfaSecretEncrypted, users.hr.id));
      const done = await a.request("POST", "/api/auth/login/mfa", { body: { challengeToken: res.body.data.challengeToken, code: codeFor(hrSecret) } });
      a.state.csrf = done.body.data.csrfToken;
      const other = agent(base);
      const otherLogin = await login(other, users.hr);
      await allowNextCode(users.hr.id);
      await other.request("POST", "/api/auth/login/mfa", { body: { challengeToken: otherLogin.body.data.challengeToken, code: codeFor(hrSecret) } });
      assert.equal((await a.request("POST", "/api/auth/mfa/disable", { body: { password: "wrong", code: "123456" } })).code, "AUTH_PASSWORD_INVALID");
      await allowNextCode(users.hr.id);
      const disabled = await a.request("POST", "/api/auth/mfa/disable", { body: { password: PASSWORD, code: codeFor(hrSecret) } });
      assert.equal(disabled.status, 200, disabled.text);
      assert.equal((await other.request("GET", "/api/auth/me")).status, 401, "other sessions end");
      assert.equal((await a.request("GET", "/api/auth/me")).status, 200, "the current session survives");
      assert.ok(await prisma.auditLog.count({ where: { action: "MFA_DISABLED", adminUserId: users.hr.id } }));
    });

    await t.test("Google sign-in never puts a token in the URL outside legacy mode", async () => {
      const capture = () => {
        const res = { cookies: [], redirectedTo: null, cookie(name, value, options) { this.cookies.push({ name, value, options }); }, clearCookie() {}, redirect(url) { this.redirectedTo = url; } };
        return res;
      };
      const req = (user) => ({ user, ip: "127.0.0.1", headers: { "user-agent": "test" } });
      for (const mode of ["dual", "cookie"]) {
        setMode(mode);
        const res = capture();
        await new Promise((resolve, reject) => { authController.googleCallback(req(users.carol), res, (error) => (error ? reject(error) : resolve())); setTimeout(resolve, 1500); });
        assert.ok(res.redirectedTo.endsWith("/auth/google/callback?session=1"), res.redirectedTo);
        assert.ok(res.cookies.some((c) => c.name === "cf_at" && c.options.httpOnly));
      }
      setMode("legacy");
      const legacyRes = capture();
      await new Promise((resolve) => { authController.googleCallback(req(users.carol), legacyRes, resolve); setTimeout(resolve, 1500); });
      assert.match(legacyRes.redirectedTo, /\?token=/, "legacy contract unchanged");
    });
  } finally {
    // Audit rows are append-only by design, so seeded users (unique per run) are left in the disposable DB.
    setMode("legacy");
    await closeServer(server);
    await prisma.$disconnect();
  }
});
