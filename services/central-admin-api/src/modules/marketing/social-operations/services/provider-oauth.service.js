const crypto = require('crypto');
const axios = require('axios');
const ApiError = require('../../../../shared/utils/ApiError');
const { createOAuthState, consumeOAuthState } = require('../security/oauth-state.service');
const { assertAllowedRedirectUri } = require('../security/redirect-uri.policy');
const { encryptJson } = require('../security/encryption.service');
const CREDENTIAL_PURPOSE = 'SOCIAL_ACCOUNT_CONNECTION_CREDENTIALS';
const PROVIDERS = Object.freeze({
    META: { label: 'Facebook & Instagram', authorize: 'https://www.facebook.com/v25.0/dialog/oauth', token: 'https://graph.facebook.com/v25.0/oauth/access_token', scopes: 'pages_show_list,pages_read_engagement,instagram_basic', profile: 'https://graph.facebook.com/v25.0/me?fields=id,name' },
    TIKTOK: { label: 'TikTok', authorize: 'https://www.tiktok.com/v2/auth/authorize/', token: 'https://open.tiktokapis.com/v2/oauth/token/', scopes: 'user.info.basic,video.list', profile: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name' },
    X: { label: 'X', authorize: 'https://x.com/i/oauth2/authorize', token: 'https://api.x.com/2/oauth2/token', scopes: 'tweet.read users.read offline.access', profile: 'https://api.x.com/2/users/me' },
    LINKEDIN: { label: 'LinkedIn', authorize: 'https://www.linkedin.com/oauth/v2/authorization', token: 'https://www.linkedin.com/oauth/v2/accessToken', scopes: 'openid profile', profile: 'https://api.linkedin.com/v2/userinfo' },
});
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const cookieName = state => `cf_social_oauth_${digest(state).slice(0, 24)}`;
function settings(provider, env = process.env) {
    const def = PROVIDERS[provider];
    if (!def)
        throw new ApiError(400, 'Unsupported social provider');
    const clientId = env[`SOCIAL_${provider}_CLIENT_ID`] || (provider === 'META' ? env.META_APP_ID : undefined);
    const clientSecret = env[`SOCIAL_${provider}_CLIENT_SECRET`] || (provider === 'META' ? env.META_APP_SECRET : undefined);
    const redirectUri = env[`SOCIAL_${provider}_REDIRECT_URI`];
    if (!clientId || !clientSecret || !redirectUri)
        throw new ApiError(503, `${def.label} connection is not configured. Ask your administrator to configure the social provider app.`);
    assertAllowedRedirectUri({ redirectUri, allowList: String(env.SOCIAL_OAUTH_REDIRECT_URIS || env.SOCIAL_OPERATIONS_OAUTH_REDIRECT_URIS || '').split(',').map(value => value.trim()).filter(Boolean) });
    return { ...def, clientId, clientSecret, redirectUri, scopes: env[`SOCIAL_${provider}_SCOPES`] || def.scopes };
}
function providerReadiness(env = process.env) {
    return Object.entries(PROVIDERS).map(([provider, def]) => { try {
        settings(provider, env);
        return { provider, label: def.label, available: true };
    }
    catch {
        return { provider, label: def.label, available: false, reason: 'Provider app setup is required' };
    } });
}
function createProviderOAuth({ db, http = axios, env = process.env, keyring, allowList } = {}) {
    const options = { db, keyring, allowList };
    async function start({ provider, adminUserId, browserBinding, connectionId }) {
        const cfg = settings(provider, env);
        if (!adminUserId || !browserBinding)
            throw new ApiError(401, 'Sign in before connecting a social account');
        if (connectionId) {
            const existing = await db.socialAccountConnection.findUnique({ where: { id: connectionId } });
            if (!existing || existing.provider !== provider)
                throw new ApiError(404, 'Social connection not found');
        }
        const state = await createOAuthState({ ...options, provider, adminUserId, redirectUri: cfg.redirectUri, connectionContext: { connectionId: connectionId || null, browserHash: digest(browserBinding) } });
        const url = new URL(cfg.authorize);
        url.search = new URLSearchParams({ response_type: 'code', [provider === 'TIKTOK' ? 'client_key' : 'client_id']: cfg.clientId, redirect_uri: cfg.redirectUri, state: state.state, scope: cfg.scopes }).toString();
        if (provider === 'X') {
            url.searchParams.set('code_challenge', state.pkceChallenge);
            url.searchParams.set('code_challenge_method', 'S256');
        }
        return { provider, authorizationUrl: url.toString(), expiresAt: state.expiresAt, state: state.state };
    }
    async function complete({ provider, query, browserBinding }) {
        const cfg = settings(provider, env);
        if (typeof query?.state !== 'string' || !browserBinding)
            throw new ApiError(400, 'This connection has expired. Start again from Social Operations.');
        const pending = await db.socialOAuthState.findUnique({ where: { stateHash: digest(query.state) } });
        if (!pending || pending.connectionContextJson?.browserHash !== digest(browserBinding))
            throw new ApiError(400, 'Invalid social connection session');
        const state = await consumeOAuthState({ ...options, provider, rawState: query.state, redirectUri: cfg.redirectUri });
        if (query.error)
            throw new ApiError(400, 'Authorization was cancelled or declined. You can try again.');
        if (typeof query.code !== 'string' || !query.code)
            throw new ApiError(400, 'The provider did not return an authorization code');
        const owner = await db.adminUser.findUnique({ where: { id: pending.adminUserId }, select: { id: true, status: true } });
        if (owner?.status !== 'ACTIVE')
            throw new ApiError(403, 'The account that started this connection is no longer active');
        const body = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: cfg.redirectUri });
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (provider === 'X') {
            body.set('code_verifier', state.codeVerifier);
            headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
        }
        else {
            body.set(provider === 'TIKTOK' ? 'client_key' : 'client_id', cfg.clientId);
            body.set('client_secret', cfg.clientSecret);
        }
        try {
            const token = (await http.post(cfg.token, body.toString(), { headers, timeout: 15000, maxRedirects: 0 })).data;
            if (!token?.access_token || token.error)
                throw new Error('Invalid provider token response');
            const auth = { headers: { Authorization: `Bearer ${token.access_token}` }, timeout: 15000, maxRedirects: 0 };
            const raw = (await http.get(cfg.profile, auth)).data;
            const profile = provider === 'X' ? raw?.data : provider === 'TIKTOK' ? { id: raw?.data?.user?.open_id, name: raw?.data?.user?.display_name } : provider === 'LINKEDIN' ? { id: raw?.sub, name: raw?.name } : raw;
            if (!profile?.id)
                throw new Error('Provider account could not be verified');
            const providerConnectionId = String(profile.id);
            const identities = [];
            if (provider !== 'META')
                identities.push({ id: providerConnectionId, name: profile.name || profile.username || providerConnectionId, username: profile.username || null, type: { TIKTOK: 'TIKTOK_ACCOUNT', X: 'X_USER', LINKEDIN: 'LINKEDIN_MEMBER' }[provider] });
            if (provider === 'META') {
                let after;
                do {
                    const url = new URL('https://graph.facebook.com/v25.0/me/accounts');
                    url.searchParams.set('fields', 'id,name,instagram_business_account{id,name,username}');
                    url.searchParams.set('limit', '100');
                    if (after)
                        url.searchParams.set('after', after);
                    const pages = (await http.get(url.toString(), auth)).data;
                    if (!Array.isArray(pages?.data))
                        throw new Error('Page discovery failed');
                    for (const page of pages.data) {
                        if (!page.id)
                            continue;
                        identities.push({ id: String(page.id), name: page.name || String(page.id), type: 'FACEBOOK_PAGE' });
                        const ig = page.instagram_business_account;
                        if (ig?.id)
                            identities.push({ id: String(ig.id), name: ig.name || ig.username || String(ig.id), username: ig.username || null, type: 'INSTAGRAM_PROFESSIONAL' });
                    }
                    const next = pages.paging?.next ? pages.paging?.cursors?.after : null;
                    if (next && next === after)
                        throw new Error('Invalid page cursor');
                    after = next;
                    if (identities.length > 2000)
                        throw new Error('Too many identities; narrow the approved account selection');
                } while (after);
            }
            const scopes = String(token.scope || '').split(/[ ,]+/).filter(Boolean);
            if (provider === 'META') {
                const grants = (await http.get('https://graph.facebook.com/v25.0/me/permissions', auth)).data?.data;
                if (!Array.isArray(grants))
                    throw new Error('Provider permissions could not be verified');
                scopes.push(...grants.filter(g => g.status === 'granted').map(g => g.permission));
            }
            const encryptedCredentials = encryptJson({ accessToken: token.access_token, refreshToken: token.refresh_token || null }, { purpose: CREDENTIAL_PURPOSE, keyring });
            const expires = seconds => Number(seconds) > 0 ? new Date(Date.now() + Number(seconds) * 1000) : null;
            const data = { encryptedCredentials, scopes, status: 'ACTIVE', requiresReauthorization: false, accessTokenExpiresAt: expires(token.expires_in), refreshTokenExpiresAt: expires(token.refresh_expires_in) };
            const connection = await db.$transaction(async (tx) => {
                const requestedId = state.connectionContext.connectionId;
                const existing = requestedId ? await tx.socialAccountConnection.findUnique({ where: { id: requestedId } }) : null;
                if (requestedId && (!existing || existing.provider !== provider || existing.providerConnectionId !== providerConnectionId))
                    throw new ApiError(409, 'Reconnect using the same social account');
                const saved = requestedId ? await tx.socialAccountConnection.update({ where: { id: requestedId }, data: { ...data, credentialVersion: { increment: 1 } } }) : await tx.socialAccountConnection.upsert({ where: { provider_providerConnectionId: { provider, providerConnectionId } }, create: { ...data, provider, providerConnectionId, createdById: owner.id }, update: { ...data, credentialVersion: { increment: 1 } } });
                for (const identity of identities) {
                    const values = { type: identity.type, name: identity.name, username: identity.username || null };
                    await tx.socialPublishingIdentity.upsert({ where: { connectionId_providerIdentityId: { connectionId: saved.id, providerIdentityId: identity.id } }, create: { ...values, connectionId: saved.id, providerIdentityId: identity.id, capabilitiesJson: {} }, update: values });
                }
                await tx.auditLog.create({ data: { adminUserId: owner.id, action: "PROFILE_UPDATED", targetId: saved.id, targetType: "SOCIAL_ACCOUNT_CONNECTION", metadata: { operation: "SOCIAL_ACCOUNT_AUTHORIZED", provider, identityCount: identities.length } } });
                return saved;
            });
            return { id: connection.id, provider, connected: true, status: connection.status };
        }
        catch (error) {
            if (error instanceof ApiError)
                throw error;
            throw new ApiError(502, 'We could not verify this social account with the provider. Start the connection again.');
        }
    }
    return { start, complete };
}
module.exports = { createProviderOAuth, providerReadiness, cookieName, PROVIDERS };
