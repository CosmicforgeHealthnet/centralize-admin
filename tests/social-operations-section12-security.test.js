const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  createKeyring,
} = require("../src/modules/marketing/social-operations/security/encryption-keyring.service");
const {
  encryptJson,
  decryptJson,
  encryptBuffer,
  decryptBuffer,
} = require("../src/modules/marketing/social-operations/security/encryption.service");
const {
  createOAuthState,
  consumeOAuthState,
  hashOAuthState,
} = require("../src/modules/marketing/social-operations/security/oauth-state.service");
const {
  assertAllowedRedirectUri,
} = require("../src/modules/marketing/social-operations/security/redirect-uri.policy");
const {
  sanitizeSecretSafe,
} = require("../src/modules/marketing/social-operations/security/secret-safe-serializer");
const {
  redactLogPayload,
  REDACTED,
} = require("../src/modules/marketing/social-operations/security/log-redaction.service");
const {
  validateActionPayload,
} = require("../src/modules/marketing/social-operations/security/sensitive-payload.validator");
const {
  rotateSocialConnectionCredentials,
  CREDENTIAL_PURPOSE,
} = require("../src/modules/marketing/social-operations/security/credential-rotation.service");
const {
  sanitizeForResponse,
} = require("../src/modules/marketing/social-operations/services/sanitization.service");

function key(version = 1) {
  return crypto.createHash("sha256").update(`section12-key-${version}`).digest();
}

function keyring(activeVersion = "1") {
  return createKeyring({
    keys: { "1": key(1), "2": key(2) },
    activeVersion,
  });
}

function tamperEnvelope(buffer, mutate) {
  const text = buffer.toString("utf8");
  const prefix = "cf-social-aead:";
  const envelope = JSON.parse(text.slice(prefix.length));
  mutate(envelope);
  return Buffer.from(`${prefix}${JSON.stringify(envelope)}`);
}

test("AEAD encryption is authenticated, versioned, and non-deterministic", () => {
  const first = encryptJson({ access: "synthetic-secret" }, {
    purpose: CREDENTIAL_PURPOSE,
    keyring: keyring("1"),
  });
  const second = encryptJson({ access: "synthetic-secret" }, {
    purpose: CREDENTIAL_PURPOSE,
    keyring: keyring("1"),
  });

  assert.notEqual(first.toString("utf8"), JSON.stringify({ access: "synthetic-secret" }));
  assert.notEqual(first.toString("utf8"), second.toString("utf8"));
  assert.deepEqual(
    decryptJson(first, { purpose: CREDENTIAL_PURPOSE, keyring: keyring("1") }),
    { access: "synthetic-secret" },
  );

  assert.throws(
    () =>
      decryptJson(
        tamperEnvelope(first, (envelope) => {
          envelope.ciphertext = Buffer.from("modified").toString("base64");
        }),
        { purpose: CREDENTIAL_PURPOSE, keyring: keyring("1") },
      ),
    /authentication failed/,
  );
  assert.throws(
    () =>
      decryptJson(
        tamperEnvelope(first, (envelope) => {
          envelope.tag = Buffer.alloc(16).toString("base64");
        }),
        { purpose: CREDENTIAL_PURPOSE, keyring: keyring("1") },
      ),
    /authentication failed/,
  );
  assert.throws(
    () =>
      decryptBuffer(
        tamperEnvelope(first, (envelope) => {
          envelope.keyVersion = "missing";
        }),
        { purpose: CREDENTIAL_PURPOSE, keyring: keyring("1") },
      ),
    /authentication failed/,
  );
});

test("credential rotation changes credentialVersion without returning plaintext", async () => {
  const row = {
    id: "connection-1",
    provider: "META",
    credentialVersion: 1,
    encryptedCredentials: encryptJson(
      { accessToken: "synthetic-token", refreshToken: "synthetic-refresh" },
      { purpose: CREDENTIAL_PURPOSE, keyring: keyring("1") },
    ),
  };
  const auditRows = [];
  const db = {
    socialAccountConnection: {
      async findUnique() {
        return row;
      },
      async update({ data }) {
        row.encryptedCredentials = data.encryptedCredentials;
        row.credentialVersion += 1;
        return { ...row };
      },
    },
  };

  const result = await rotateSocialConnectionCredentials({
    connectionId: row.id,
    db,
    keyring: keyring("2"),
    actorId: "admin-1",
    auditWriter: async (entry) => auditRows.push(entry),
  });

  assert.equal(result.credentialVersion, 2);
  assert.equal(result.keyVersion, "2");
  assert.equal(row.encryptedCredentials.includes("synthetic-token"), false);
  assert.equal(JSON.stringify(auditRows).includes("synthetic-token"), false);
});

function fakeOAuthDb() {
  const rows = [];
  return {
    rows,
    socialOAuthState: {
      async create({ data }) {
        const row = { id: `state-${rows.length + 1}`, usedAt: null, ...data };
        rows.push(row);
        return row;
      },
      async findUnique({ where }) {
        return rows.find((row) => row.stateHash === where.stateHash) || null;
      },
      async updateMany({ where, data }) {
        const row = rows.find(
          (candidate) =>
            candidate.stateHash === where.stateHash &&
            candidate.provider === where.provider &&
            candidate.usedAt === null &&
            candidate.expiresAt > where.expiresAt.gt,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
}

test("OAuth state stores only a hash, encrypts PKCE, and is single-use", async () => {
  const db = fakeOAuthDb();
  const redirectUri = "https://admin.cosmicforge.example/api/v1/marketing/social/oauth/meta/callback";
  const created = await createOAuthState({
    provider: "META",
    adminUserId: "admin-1",
    redirectUri,
    allowList: [redirectUri],
    db,
    keyring: keyring("1"),
    now: () => new Date("2026-07-16T12:00:00Z"),
  });

  assert.equal(created.state.length > 32, true);
  assert.equal(db.rows[0].stateHash, hashOAuthState(created.state));
  assert.equal(JSON.stringify(db.rows[0]).includes(created.state), false);
  assert.ok(Buffer.isBuffer(db.rows[0].encryptedVerifier));
  assert.equal(db.rows[0].encryptedVerifier.toString("utf8").includes("code"), false);

  const consumed = await consumeOAuthState({
    provider: "META",
    rawState: created.state,
    redirectUri,
    allowList: [redirectUri],
    db,
    keyring: keyring("1"),
    now: () => new Date("2026-07-16T12:01:00Z"),
  });
  assert.equal(consumed.stateVerified, true);
  assert.equal(consumed.codeVerifier.length > 32, true);

  await assert.rejects(
    consumeOAuthState({
      provider: "META",
      rawState: created.state,
      redirectUri,
      allowList: [redirectUri],
      db,
      keyring: keyring("1"),
      now: () => new Date("2026-07-16T12:02:00Z"),
    }),
    /OAuth state is invalid/,
  );
});

test("OAuth duplicate callback race permits only one consumption", async () => {
  const db = fakeOAuthDb();
  const redirectUri = "http://localhost:4000/api/v1/marketing/social/oauth/meta/callback";
  const created = await createOAuthState({
    provider: "META",
    adminUserId: "admin-1",
    redirectUri,
    allowList: [redirectUri],
    db,
    keyring: keyring("1"),
    now: () => new Date("2026-07-16T12:00:00Z"),
  });

  const attempts = await Promise.allSettled([
    consumeOAuthState({
      provider: "META",
      rawState: created.state,
      redirectUri,
      allowList: [redirectUri],
      db,
      keyring: keyring("1"),
      now: () => new Date("2026-07-16T12:01:00Z"),
    }),
    consumeOAuthState({
      provider: "META",
      rawState: created.state,
      redirectUri,
      allowList: [redirectUri],
      db,
      keyring: keyring("1"),
      now: () => new Date("2026-07-16T12:01:00Z"),
    }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
});

test("redirect policy is exact-match only", () => {
  const allowed = "https://admin.cosmicforge.example/api/v1/marketing/social/oauth/meta/callback";
  assert.equal(assertAllowedRedirectUri({ redirectUri: allowed, allowList: [allowed] }), allowed);
  for (const attack of [
    `${allowed}/evil`,
    "https://admin.cosmicforge.example.evil.com/api/v1/marketing/social/oauth/meta/callback",
    `${allowed}?redirect=evil`,
    allowed.replace("https://", "http://"),
  ]) {
    assert.throws(
      () => assertAllowedRedirectUri({ redirectUri: attack, allowList: [allowed] }),
      /not allowed/,
    );
  }
  assert.throws(
    () =>
      assertAllowedRedirectUri({
        redirectUri: "http://localhost:4000/callback",
        allowList: [],
        nodeEnv: "test",
      }),
    /not allowed/,
  );
});

test("serializer, response sanitizer, log redaction, and payload validator remove secrets", () => {
  const source = {
    id: "safe",
    encryptedCredentials: Buffer.from("cipher"),
    nested: { access_token: "secret", safeStatus: "ACTIVE" },
    provider: "META",
  };
  const sanitized = sanitizeSecretSafe(source);
  assert.deepEqual(sanitized, { id: "safe", nested: { safeStatus: "ACTIVE" }, provider: "META" });
  assert.equal(source.nested.access_token, "secret");
  assert.deepEqual(sanitizeForResponse(source), sanitized);

  const logPayload = redactLogPayload({
    message: "operator-readable event",
    data: {
      messageContent: "private text",
      attachmentUrls: ["https://example.test/file"],
      provider: "META",
    },
  });
  assert.equal(logPayload.message, "operator-readable event");
  assert.equal(logPayload.data.messageContent, REDACTED);
  assert.equal(logPayload.data.attachmentUrls, REDACTED);
  assert.equal(logPayload.data.provider, "META");

  assert.deepEqual(
    validateActionPayload({ publicationId: "pub-1", retry: { attempt: 1 } }),
    { publicationId: "pub-1", retry: { attempt: 1 } },
  );
  assert.throws(
    () => validateActionPayload({ nested: { commentText: "private" } }),
    /not allowed/,
  );
  assert.throws(
    () => validateActionPayload({ file: Buffer.from("private") }),
    /not allowed/,
  );
});
