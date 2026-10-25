// Client-side view of the HQ session mode.
//
// legacy: access token in localStorage + JS cookie (old contract, unchanged).
// dual / cookie: credentials are httpOnly cookies set by the API. The browser
//   never persists a token. The CSRF token lives in memory only and is
//   re-fetched from GET /api/auth/session after a reload. `cf_session` is a
//   non-credential hint cookie on the frontend domain so the Next middleware
//   can route; it grants nothing by itself.
//
// In dual mode, if the browser refuses the API cookies (e.g. third-party cookie
// blocking when the API is cross-site), the body token is kept IN MEMORY only
// as a Bearer fallback for this tab.

export type SessionMode = "legacy" | "dual" | "cookie";

const MODE_KEY = "auth-mode";
const HINT_COOKIE = "cf_session";
const LEGACY_TOKEN_KEY = "accessToken";
const LEGACY_TOKEN_COOKIE = "accessToken";

let csrfToken: string | null = null;
let memoryToken: string | null = null;

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getMode(): SessionMode {
  const stored = safeLocalStorage()?.getItem(MODE_KEY);
  return stored === "dual" || stored === "cookie" ? stored : "legacy";
}

function setMode(mode: SessionMode) {
  safeLocalStorage()?.setItem(MODE_KEY, mode);
}

export function getCsrfToken() {
  return csrfToken;
}

export function setCsrfToken(token: string | null | undefined) {
  csrfToken = token || null;
}

// Bearer token to attach, if any. Never read from storage outside legacy mode.
export function getBearerToken(): string | null {
  if (getMode() === "legacy") return safeLocalStorage()?.getItem(LEGACY_TOKEN_KEY) ?? null;
  return memoryToken;
}

function setHintCookie() {
  document.cookie = `${HINT_COOKIE}=1; path=/; max-age=${7 * 24 * 60 * 60}; samesite=strict${location.protocol === "https:" ? "; secure" : ""}`;
}

function clearLegacyToken() {
  safeLocalStorage()?.removeItem(LEGACY_TOKEN_KEY);
  document.cookie = `${LEGACY_TOKEN_COOKIE}=; path=/; max-age=0`;
}

export interface SessionPayload {
  accessToken?: string;
  csrfToken?: string;
  session?: { mode?: SessionMode };
}

// Apply credentials from a login/refresh/MFA response.
export function applySessionPayload(data: SessionPayload, { cookieWorks = true } = {}) {
  const mode: SessionMode = data.session?.mode === "dual" || data.session?.mode === "cookie" ? data.session.mode : "legacy";
  setMode(mode);
  if (mode === "legacy") {
    if (data.accessToken) {
      safeLocalStorage()?.setItem(LEGACY_TOKEN_KEY, data.accessToken);
      document.cookie = `${LEGACY_TOKEN_COOKIE}=${data.accessToken}; path=/; max-age=${8 * 60 * 60}; secure; samesite=strict`;
    }
    memoryToken = null;
    csrfToken = null;
    return mode;
  }
  clearLegacyToken();
  setCsrfToken(data.csrfToken);
  memoryToken = mode === "dual" && !cookieWorks ? data.accessToken ?? null : null;
  setHintCookie();
  return mode;
}

export function setMemoryFallbackToken(token: string | null) {
  memoryToken = getMode() === "dual" ? token : null;
}

export function clearSessionState() {
  clearLegacyToken();
  csrfToken = null;
  memoryToken = null;
  document.cookie = `${HINT_COOKIE}=; path=/; max-age=0`;
  safeLocalStorage()?.removeItem(MODE_KEY);
}
