const crypto = require("crypto");
const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const { encryptJson, decryptJson } = require("./encryption.service");
const { createPkcePair } = require("./pkce.service");
const { assertAllowedRedirectUri } = require("./redirect-uri.policy");

const OAUTH_STATE_PURPOSE = "SOCIAL_OAUTH_PKCE_VERIFIER";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;

function hashOAuthState(rawState) {
  return crypto.createHash("sha256").update(String(rawState)).digest("hex");
}

function boundedTtlMs(value) {
  const parsed = Number(value || DEFAULT_TTL_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, parsed));
}

async function createOAuthState({
  provider,
  adminUserId,
  connectionContext = {},
  redirectUri,
  db = prisma,
  keyring,
  allowList,
  ttlMs = Number(process.env.SOCIAL_OAUTH_STATE_TTL_MS || DEFAULT_TTL_MS),
  now = () => new Date(),
} = {}) {
  const allowedRedirectUri = assertAllowedRedirectUri({ redirectUri, allowList });
  const rawState = crypto.randomBytes(48).toString("base64url");
  const pkce = createPkcePair();
  const expiresAt = new Date(now().getTime() + boundedTtlMs(ttlMs));

  await db.socialOAuthState.create({
    data: {
      stateHash: hashOAuthState(rawState),
      provider,
      adminUserId,
      connectionContextJson: {
        ...connectionContext,
        redirectUri: allowedRedirectUri,
        pkceMethod: pkce.method,
      },
      encryptedVerifier: encryptJson(
        { verifier: pkce.verifier },
        { purpose: OAUTH_STATE_PURPOSE, keyring },
      ),
      expiresAt,
    },
  });

  return {
    provider,
    state: rawState,
    expiresAt,
    pkceChallenge: pkce.challenge,
    pkceMethod: pkce.method,
  };
}

async function consumeOAuthState({
  provider,
  rawState,
  redirectUri,
  db = prisma,
  keyring,
  allowList,
  now = () => new Date(),
} = {}) {
  const allowedRedirectUri = assertAllowedRedirectUri({ redirectUri, allowList });
  const stateHash = hashOAuthState(rawState || "");
  const currentTime = now();
  const row = await db.socialOAuthState.findUnique({ where: { stateHash } });
  if (
    !row ||
    row.provider !== provider ||
    row.usedAt ||
    row.expiresAt.getTime() <= currentTime.getTime() ||
    row.connectionContextJson?.redirectUri !== allowedRedirectUri
  ) {
    throw new ApiError(400, "OAuth state is invalid");
  }

  const updateResult = await db.socialOAuthState.updateMany({
    where: {
      stateHash,
      provider,
      usedAt: null,
      expiresAt: { gt: currentTime },
    },
    data: { usedAt: currentTime },
  });

  if (!updateResult.count) {
    throw new ApiError(400, "OAuth state is invalid");
  }

  return {
    provider,
    stateVerified: true,
    connectionContext: {
      ...(row.connectionContextJson || {}),
      redirectUri: undefined,
    },
    codeVerifier: decryptJson(row.encryptedVerifier, {
      purpose: OAUTH_STATE_PURPOSE,
      keyring,
    }).verifier,
  };
}

module.exports = {
  OAUTH_STATE_PURPOSE,
  DEFAULT_TTL_MS,
  hashOAuthState,
  createOAuthState,
  consumeOAuthState,
};
