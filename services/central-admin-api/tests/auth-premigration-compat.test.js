"use strict";

// Deploy-safety: the API built from this branch must behave exactly like the
// pre-release login while migration 20261025_add_admin_sessions_mfa.sql is
// NOT applied (merge to staging auto-deploys; manual migrations come later).
//
// Database: AUTH_PREMIGRATION_DATABASE_URL if set (e.g. a DB pushed from the
// origin/staging schema); otherwise a disposable "<db>_auth_premig" database is
// created next to DATABASE_URL from the current schema with the migration's
// tables dropped - identical to the pre-migration schema because the migration
// only ADDS tables.

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { Client } = require("pg");

const AUTH_TABLES = ["admin_sessions", "admin_session_refresh_tokens", "admin_mfa_enrollments", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_auth_events"];
const ROOT = path.resolve(__dirname, "..");

async function preparePremigrationDatabase() {
  if (process.env.AUTH_PREMIGRATION_DATABASE_URL) return process.env.AUTH_PREMIGRATION_DATABASE_URL;
  const base = new URL(process.env.DATABASE_URL);
  const name = `${base.pathname.slice(1)}_auth_premig`.replace(/[^a-zA-Z0-9_]/g, "_");
  const maintenance = new URL(base);
  maintenance.pathname = "/postgres";
  const admin = new Client({ connectionString: maintenance.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const target = new URL(base);
  target.pathname = `/${name}`;
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: target.toString() },
    stdio: "ignore",
  });
  const db = new Client({ connectionString: target.toString() });
  await db.connect();
  await db.query(AUTH_TABLES.map((t) => `DROP TABLE IF EXISTS "${t}" CASCADE;`).join("\n"));
  await db.end();
  return target.toString();
}

test("pre-migration database: new code serves the exact pre-release login", { timeout: 180000 }, async (t) => {
  const url = await preparePremigrationDatabase();
  Object.assign(process.env, {
    DATABASE_URL: url,
    NODE_ENV: "test",
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET || "test-admin-jwt-secret-premigration",
    CORS_ORIGINS: "http://localhost:3000",
    // An operator flipping the flag before migrating must not break login.
    AUTH_SESSION_MODE: "cookie",
    AUTH_MFA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
  });

  const { createApp } = require("../src/app");
  const { prisma } = require("../src/shared/config/database");
  const { hashPassword } = require("../src/shared/utils/password.util");
  const { createEmergencyOverrideService } = require("../src/modules/marketing/advertising-execution/policy/emergency-override.service");
  const { closeServer } = require("./helpers/server-close");
  const jwt = require("jsonwebtoken");

  const tables = await prisma.$queryRawUnsafe(`SELECT ${AUTH_TABLES.map((n, i) => `to_regclass('public.${n}') IS NOT NULL AS t${i}`).join(", ")}`);
  assert.ok(Object.values(tables[0]).every((v) => v === false), "test database really is pre-migration");

  const run = Date.now().toString(36);
  const PASSWORD = "Correct-Horse-9!";
  const superUser = await prisma.adminUser.create({ data: { email: `premig-super-${run}@cosmicforge.test`, name: "Premig Super", password: await hashPassword(PASSWORD), status: "ACTIVE", mustChangePassword: false, tier: "SUPER", twoFactorEnabled: true } });
  const employee = await prisma.adminUser.create({ data: { email: `premig-emp-${run}@cosmicforge.test`, name: "Premig Employee", password: await hashPassword(PASSWORD), status: "ACTIVE", mustChangePassword: false, tier: "EMPLOYEE" } });

  const app = createApp({ env: process.env });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { body, token, cookie } = {}) => {
    const headers = { origin: "http://localhost:3000", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
    if (body) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, cookies: res.headers.getSetCookie() };
  };
  const cookieValue = (setCookies, name) => {
    const hit = setCookies.find((c) => c.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.split(";")[0].slice(name.length + 1)) : null;
  };

  try {
    let token;
    let refresh;
    await t.test("login: legacy body, legacy cookies, 8h token without a session, refresh row in admin_refresh_tokens", async () => {
      const res = await call("POST", "/api/auth/login", { body: { email: superUser.email, password: PASSWORD } });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(Object.keys(res.body.data).sort(), ["accessToken", "mustChangePassword", "user"], "response shape is the pre-release one");
      token = res.body.data.accessToken;
      const decoded = jwt.decode(token);
      assert.equal(decoded.sid, undefined, "no session id");
      assert.equal(decoded.exp - decoded.iat, 8 * 3600, "8h token as before");
      refresh = cookieValue(res.cookies, "refreshToken");
      assert.ok(refresh, "legacy refresh cookie");
      assert.ok(cookieValue(res.cookies, "isLoggedIn"));
      assert.ok(!res.cookies.some((c) => /^(__Host-|__Secure-)?cf_/.test(c)), "no session cookies although AUTH_SESSION_MODE=cookie");
      assert.equal(await prisma.refreshToken.count({ where: { adminUserId: superUser.id, isRevoked: false } }), 1);
      assert.ok(await prisma.auditLog.count({ where: { adminUserId: superUser.id, action: "LOGIN" } }));
      assert.equal(res.body.data.mfaRequired, undefined, "legacy twoFactorEnabled flag does not trigger an MFA challenge");
    });

    await t.test("/me, HR and Marketing routes work with the Bearer token", async () => {
      const me = await call("GET", "/api/auth/me", { token });
      assert.equal(me.status, 200);
      assert.equal(me.body.data.email, superUser.email);
      assert.equal((await call("GET", "/api/profile/me", { token })).status, 200);
      const hr = await call("GET", "/api/hrm/attendance", { token });
      assert.equal(hr.status, 200, hr.text);
      const marketing = await call("GET", "/api/marketing/campaigns", { token });
      assert.equal(marketing.status, 200, marketing.text);
    });

    await t.test("refresh rotates the legacy refresh token exactly as before", async () => {
      const res = await call("POST", "/api/auth/refresh-token", { cookie: `refreshToken=${encodeURIComponent(refresh)}` });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(Object.keys(res.body.data), ["accessToken"]);
      assert.equal(jwt.decode(res.body.data.accessToken).sid, undefined);
      const replay = await call("POST", "/api/auth/refresh-token", { cookie: `refreshToken=${encodeURIComponent(refresh)}` });
      assert.equal(replay.status, 401, "old token is revoked, as before");
      refresh = cookieValue(res.cookies, "refreshToken");
      token = res.body.data.accessToken;
    });

    await t.test("session and MFA endpoints answer 503 AUTH_SCHEMA_NOT_READY", async () => {
      for (const [method, p, body] of [["GET", "/api/auth/mfa/status"], ["POST", "/api/auth/mfa/enroll", { password: PASSWORD }], ["POST", "/api/auth/mfa/step-up", { code: "123456" }], ["GET", "/api/auth/sessions"], ["POST", "/api/auth/logout-all", {}], ["POST", "/api/auth/login/mfa", { challengeToken: "x".repeat(30), code: "123456" }]]) {
        const res = await call(method, p, { token, body });
        assert.equal(res.status, 503, `${method} ${p}: ${res.text}`);
        assert.equal(res.body.code, "AUTH_SCHEMA_NOT_READY");
      }
      const session = await call("GET", "/api/auth/session", { token });
      assert.equal(session.status, 200);
      assert.equal(session.body.data.mode, "legacy");
      assert.equal(session.body.data.mfa.available, false);
    });

    await t.test("emergency override fails closed: verified MFA is unavailable", async () => {
      const service = createEmergencyOverrideService({ client: prisma, events: { emit: async () => {} } });
      await assert.rejects(
        service.create({ actor: { id: superUser.id, tier: "SUPER", mfa: { enrolled: true, sessionId: "forged", verifiedAt: new Date().toISOString() } }, input: { planId: "00000000-0000-4000-8000-000000000000", allowedControls: ["CONNECTION_WRITE_GATE"], reason: "Bounded emergency recovery test", expiresAt: new Date(Date.now() + 3600000).toISOString() } }),
        (error) => error.errors?.[0]?.reasonCode === "VERIFIED_MFA_UNAVAILABLE",
      );
    });

    await t.test("logout and change-password behave as before", async () => {
      const logout = await call("POST", "/api/auth/logout", { cookie: `refreshToken=${encodeURIComponent(refresh)}` });
      assert.equal(logout.status, 200);
      assert.equal(await prisma.refreshToken.count({ where: { adminUserId: superUser.id, isRevoked: false } }), 0);
      const login = await call("POST", "/api/auth/login", { body: { email: employee.email, password: PASSWORD } });
      const changed = await call("POST", "/api/auth/change-password", { token: login.body.data.accessToken, body: { currentPassword: PASSWORD, newPassword: "New-Password-42!", confirmPassword: "New-Password-42!" } });
      assert.equal(changed.status, 200, changed.text);
      assert.equal(await prisma.refreshToken.count({ where: { adminUserId: employee.id, isRevoked: false } }), 0);
      assert.equal((await call("POST", "/api/auth/login", { body: { email: employee.email, password: "New-Password-42!" } })).status, 200);
    });

    await t.test("nothing touched the missing tables", async () => {
      const after = await prisma.$queryRawUnsafe(`SELECT ${AUTH_TABLES.map((n, i) => `to_regclass('public.${n}') IS NOT NULL AS t${i}`).join(", ")}`);
      assert.ok(Object.values(after[0]).every((v) => v === false));
    });

    await t.test("after the migration is applied, a pre-migration refresh token upgrades into a tracked session (no restart)", async () => {
      const before = await call("POST", "/api/auth/login", { body: { email: superUser.email, password: PASSWORD } });
      const legacyRefresh = cookieValue(before.cookies, "refreshToken");
      const db = new Client({ connectionString: url });
      await db.connect();
      await db.query(require("node:fs").readFileSync(path.join(ROOT, "prisma/manual-migrations/20261025_add_admin_sessions_mfa.sql"), "utf8"));
      await db.end();
      require("../src/shared/auth").authSchema.reset(); // production re-checks every 30 s
      const res = await call("POST", "/api/auth/refresh-token", { cookie: `refreshToken=${encodeURIComponent(legacyRefresh)}` });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.session.mode, "cookie", "the requested mode activates once the schema is ready");
      assert.equal(res.body.data.accessToken, undefined);
      assert.ok(res.cookies.some((c) => /^cf_at=/.test(c)));
      assert.equal(res.body.data.session.authMethod, "LEGACY_REFRESH");
      assert.equal((await prisma.refreshToken.findUnique({ where: { token: require("node:crypto").createHash("sha256").update(legacyRefresh).digest("hex") } })).isRevoked, true);
      assert.equal((await call("GET", "/api/auth/me", { token: before.body.data.accessToken })).body.code, "AUTH_BEARER_DISABLED", "cookie mode refuses Bearer (hence the documented legacy -> dual -> cookie order)");
      process.env.AUTH_SESSION_MODE = "dual";
      assert.equal((await call("GET", "/api/auth/me", { token: before.body.data.accessToken })).status, 200, "in dual mode pre-migration Bearer tokens keep working until they expire");
    });
  } finally {
    await closeServer(server);
    await prisma.$disconnect();
  }
});
