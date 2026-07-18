const crypto = require("crypto");
const axios = require("axios");
const OAuth = require("oauth-1.0a");
const ApiError = require("../../../shared/utils/ApiError");
const { prisma } = require("../../../shared/config/database");
const { encryptCredential, decryptCredential } = require("./utils/credential-encryption");
const { sanitizeProviderText } = require("./connectors/provider-http");
const { normalizePlatform, buildProviderPayload } = require("./provider-connections.service");
const providerConnectionsService = require("./provider-connections.service");

const OAUTH_PLATFORMS = new Set(["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"]);

function stateTtlSeconds() {
  const parsed = Number(process.env.MARKETING_OAUTH_STATE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 600;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function backendPublicUrl() {
  const base = String(process.env.ADMIN_BACKEND_PUBLIC_URL || "").replace(/\/$/, "");
  if (!base) throw new ApiError(503, "ADMIN_BACKEND_PUBLIC_URL is not configured");
  return base;
}

function callbackUrl(platform) {
  const envName = `${platform}_REDIRECT_URI`;
  return (
    process.env[envName] ||
    `${backendPublicUrl()}/api/v1/marketing/intelligence/oauth/${platform.toLowerCase()}/callback`
  );
}

function fixedRedirectUrl(success) {
  return (
    (success
      ? process.env.MARKETING_OAUTH_SUCCESS_REDIRECT_URL
      : process.env.MARKETING_OAUTH_FAILURE_REDIRECT_URL) ||
    process.env.ADMIN_FRONTEND_PUBLIC_URL ||
    null
  );
}

function normalizeOauthPlatform(platform) {
  const normalized = normalizePlatform(platform);
  if (!OAUTH_PLATFORMS.has(normalized)) throw new ApiError(400, "Unsupported OAuth platform");
  return normalized;
}

function oauthClient(credentials) {
  return OAuth({
    consumer: {
      key: credentials.consumerKey,
      secret: credentials.consumerSecret,
    },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });
}

function accountContext(platform, query = {}) {
  if (platform === "META") return query.accountId ? { accountId: query.accountId } : {};
  if (platform === "TIKTOK") return query.advertiserId ? { accountId: query.advertiserId } : {};
  if (platform === "X") return query.adsAccountId ? { accountId: query.adsAccountId } : {};
  if (platform === "LINKEDIN") return query.adAccountUrn ? { accountId: query.adAccountUrn } : {};
  if (platform === "GOOGLE_ADS") return query.customerId ? { accountId: query.customerId } : {};
  return {};
}

function createOauthService({ prisma: db = prisma, httpClient = axios, connections = providerConnectionsService } = {}) {
  async function persistState({ state, platform, adminUserId, query, verifier, secret, metadata }) {
    const expiresAt = new Date(Date.now() + stateTtlSeconds() * 1000);
    const context = accountContext(platform, query);
    const row = await db.marketing_oauth_states.create({
      data: {
        stateHash: sha256(state),
        platform,
        adminUserId,
        connectionId: query.connectionId || null,
        accountId: context.accountId || null,
        encryptedVerifier: verifier ? encryptCredential(verifier) : null,
        encryptedSecret: secret ? encryptCredential(secret) : null,
        metadata: {
          currency: query.currency || null,
          loginCustomerId: query.loginCustomerId || null,
          ...metadata,
        },
        expiresAt,
      },
    });
    return row;
  }

  function buildOAuth2Url(platform, query, state, codeVerifier) {
    const redirectUri = callbackUrl(platform);
    if (platform === "META") {
      if (!process.env.META_APP_ID) throw new ApiError(503, "META_APP_ID is not configured");
      const url = new URL("https://www.facebook.com/v25.0/dialog/oauth");
      url.searchParams.set("client_id", process.env.META_APP_ID);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "ads_read,business_management");
      return url.toString();
    }

    if (platform === "TIKTOK") {
      if (!process.env.TIKTOK_APP_ID) throw new ApiError(503, "TIKTOK_APP_ID is not configured");
      const url = new URL("https://business-api.tiktok.com/portal/auth");
      url.searchParams.set("app_id", process.env.TIKTOK_APP_ID);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "advertiser.read,report.read");
      return url.toString();
    }

    if (platform === "LINKEDIN") {
      if (!process.env.LINKEDIN_CLIENT_ID) throw new ApiError(503, "LINKEDIN_CLIENT_ID is not configured");
      const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", process.env.LINKEDIN_CLIENT_ID);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "r_ads_reporting r_ads");
      return url.toString();
    }

    if (platform === "GOOGLE_ADS") {
      if (!process.env.GOOGLE_ADS_CLIENT_ID) throw new ApiError(503, "GOOGLE_ADS_CLIENT_ID is not configured");
      const challenge = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", process.env.GOOGLE_ADS_CLIENT_ID);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "https://www.googleapis.com/auth/adwords");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    }

    return null;
  }

  async function buildXStart(query, state) {
    if (!process.env.X_ADS_CONSUMER_KEY || !process.env.X_ADS_CONSUMER_SECRET) {
      throw new ApiError(503, "X_ADS_CONSUMER_KEY and X_ADS_CONSUMER_SECRET are not configured");
    }
    const requestUrl = "https://api.twitter.com/oauth/request_token";
    const redirectUri = callbackUrl("X");
    const credentials = {
      consumerKey: process.env.X_ADS_CONSUMER_KEY,
      consumerSecret: process.env.X_ADS_CONSUMER_SECRET,
    };
    const oauth = oauthClient(credentials);
    const authHeader = oauth.toHeader(
      oauth.authorize({
        method: "POST",
        url: requestUrl,
        data: { oauth_callback: redirectUri },
      }),
    );
    const response = await httpClient.post(requestUrl, null, {
      headers: authHeader,
    });
    const params = new URLSearchParams(response.data);
    const requestToken = params.get("oauth_token");
    const requestSecret = params.get("oauth_token_secret");
    if (!requestToken || !requestSecret) throw new ApiError(502, "X did not return an OAuth request token");
    await persistState({
      state,
      platform: "X",
      adminUserId: query.adminUserId,
      query,
      secret: requestSecret,
      metadata: { requestToken },
    });
    const url = new URL("https://api.twitter.com/oauth/authorize");
    url.searchParams.set("oauth_token", requestToken);
    return url.toString();
  }

  async function startOAuth(platformInput, query = {}, adminUserId) {
    const platform = normalizeOauthPlatform(platformInput);
    const state = randomToken();
    const verifier = platform === "GOOGLE_ADS" ? randomToken(48) : null;
    const stateQuery = { ...query, adminUserId };

    let authorizationUrl;
    if (platform === "X") {
      authorizationUrl = await buildXStart(stateQuery, state);
      return {
        platform,
        authorizationUrl,
        stateExpiresAt: new Date(Date.now() + stateTtlSeconds() * 1000).toISOString(),
      };
    }

    authorizationUrl = buildOAuth2Url(platform, query, state, verifier);
    const row = await persistState({
      state,
      platform,
      adminUserId,
      query,
      verifier,
      metadata: {},
    });

    return {
      platform,
      authorizationUrl,
      stateExpiresAt: row.expiresAt,
    };
  }

  async function consumeState(rawState, platformInput) {
    const platform = normalizeOauthPlatform(platformInput);
    const row = await db.marketing_oauth_states.findUnique({
      where: { stateHash: sha256(rawState) },
    });
    if (!row || row.platform !== platform) throw new ApiError(400, "Invalid OAuth state");
    if (row.usedAt) throw new ApiError(400, "OAuth state has already been used");
    if (row.expiresAt < new Date()) throw new ApiError(400, "OAuth state has expired");
    await db.marketing_oauth_states.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    });
    return row;
  }

  async function exchangeOAuth2(platform, code, stateRow) {
    const redirectUri = callbackUrl(platform);
    if (platform === "META") {
      if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) throw new ApiError(503, "Meta OAuth is not configured");
      const response = await httpClient.get("https://graph.facebook.com/v25.0/oauth/access_token", {
        params: {
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          redirect_uri: redirectUri,
          code,
        },
      });
      return {
        accessToken: response.data?.access_token,
        accessTokenExpiresAt: response.data?.expires_in
          ? new Date(Date.now() + Number(response.data.expires_in) * 1000)
          : null,
      };
    }

    if (platform === "TIKTOK") {
      if (!process.env.TIKTOK_APP_ID || !process.env.TIKTOK_APP_SECRET) throw new ApiError(503, "TikTok OAuth is not configured");
      const response = await httpClient.post("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", {
        app_id: process.env.TIKTOK_APP_ID,
        secret: process.env.TIKTOK_APP_SECRET,
        auth_code: code,
        grant_type: "authorization_code",
      });
      const data = response.data?.data || response.data || {};
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        appId: process.env.TIKTOK_APP_ID,
        appSecret: process.env.TIKTOK_APP_SECRET,
        accessTokenExpiresAt: data.access_token_expire_in
          ? new Date(Date.now() + Number(data.access_token_expire_in) * 1000)
          : null,
        refreshTokenExpiresAt: data.refresh_token_expire_in
          ? new Date(Date.now() + Number(data.refresh_token_expire_in) * 1000)
          : null,
      };
    }

    if (platform === "LINKEDIN") {
      if (!process.env.LINKEDIN_CLIENT_ID || !process.env.LINKEDIN_CLIENT_SECRET) throw new ApiError(503, "LinkedIn OAuth is not configured");
      const response = await httpClient.post(
        "https://www.linkedin.com/oauth/v2/accessToken",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: process.env.LINKEDIN_CLIENT_ID,
          client_secret: process.env.LINKEDIN_CLIENT_SECRET,
        }).toString(),
        { headers: { "content-type": "application/x-www-form-urlencoded" } },
      );
      return {
        clientId: process.env.LINKEDIN_CLIENT_ID,
        clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
        accessToken: response.data?.access_token,
        refreshToken: response.data?.refresh_token,
        accessTokenExpiresAt: response.data?.expires_in
          ? new Date(Date.now() + Number(response.data.expires_in) * 1000)
          : null,
        refreshTokenExpiresAt: response.data?.refresh_token_expires_in
          ? new Date(Date.now() + Number(response.data.refresh_token_expires_in) * 1000)
          : null,
      };
    }

    if (platform === "GOOGLE_ADS") {
      if (!process.env.GOOGLE_ADS_CLIENT_ID || !process.env.GOOGLE_ADS_CLIENT_SECRET || !process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
        throw new ApiError(503, "Google Ads OAuth is not configured");
      }
      const verifier = stateRow.encryptedVerifier ? decryptCredential(stateRow.encryptedVerifier) : null;
      const response = await httpClient.post(
        "https://oauth2.googleapis.com/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: process.env.GOOGLE_ADS_CLIENT_ID,
          client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
          ...(verifier && { code_verifier: verifier }),
        }).toString(),
        { headers: { "content-type": "application/x-www-form-urlencoded" } },
      );
      return {
        clientId: process.env.GOOGLE_ADS_CLIENT_ID,
        clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        refreshToken: response.data?.refresh_token,
        developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      };
    }

    throw new ApiError(400, "Unsupported OAuth platform");
  }

  async function exchangeX(query, stateRow) {
    if (!process.env.X_ADS_CONSUMER_KEY || !process.env.X_ADS_CONSUMER_SECRET) {
      throw new ApiError(503, "X OAuth is not configured");
    }
    const requestSecret = stateRow.encryptedSecret ? decryptCredential(stateRow.encryptedSecret) : null;
    const requestToken = stateRow.metadata?.requestToken;
    if (!requestSecret || !requestToken || query.oauth_token !== requestToken) {
      throw new ApiError(400, "Invalid X OAuth callback token");
    }
    const url = "https://api.twitter.com/oauth/access_token";
    const credentials = {
      consumerKey: process.env.X_ADS_CONSUMER_KEY,
      consumerSecret: process.env.X_ADS_CONSUMER_SECRET,
    };
    const oauth = oauthClient(credentials);
    const authHeader = oauth.toHeader(
      oauth.authorize(
        {
          method: "POST",
          url,
          data: { oauth_verifier: query.oauth_verifier },
        },
        { key: requestToken, secret: requestSecret },
      ),
    );
    const response = await httpClient.post(url, new URLSearchParams({ oauth_verifier: query.oauth_verifier }).toString(), {
      headers: { ...authHeader, "content-type": "application/x-www-form-urlencoded" },
    });
    const params = new URLSearchParams(response.data);
    return {
      consumerKey: process.env.X_ADS_CONSUMER_KEY,
      consumerSecret: process.env.X_ADS_CONSUMER_SECRET,
      accessToken: params.get("oauth_token"),
      accessTokenSecret: params.get("oauth_token_secret"),
    };
  }

  async function callbackOAuth(platformInput, query = {}) {
    const platform = normalizeOauthPlatform(platformInput);
    const stateRow = await consumeState(query.state, platform);

    if (query.error) {
      throw new ApiError(400, sanitizeProviderText(query.error_description || query.error));
    }

    const credentials = platform === "X"
      ? await exchangeX(query, stateRow)
      : await exchangeOAuth2(platform, query.code, stateRow);

    if (!credentials || Object.values(credentials).every((value) => !value)) {
      throw new ApiError(502, `${platform} OAuth did not return usable credentials`);
    }

    const currency = stateRow.metadata?.currency || "UNSPECIFIED";
    const accountId = stateRow.accountId;
    if (!accountId) {
      throw new ApiError(400, "OAuth account context is missing; restart OAuth with the intended account ID");
    }

    const connection = await connections.upsertConnection(
      buildProviderPayload({
        platform,
        accountId,
        currency,
        loginCustomerId: stateRow.metadata?.loginCustomerId,
        credentials,
        accessTokenExpiresAt: credentials.accessTokenExpiresAt,
        refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
      }),
    );

    return {
      platform,
      connection,
      redirectUrl: fixedRedirectUrl(true),
    };
  }

  return {
    startOAuth,
    callbackOAuth,
    callbackUrl,
    fixedRedirectUrl,
  };
}

const defaultService = createOauthService();

module.exports = {
  createOauthService,
  ...defaultService,
};
