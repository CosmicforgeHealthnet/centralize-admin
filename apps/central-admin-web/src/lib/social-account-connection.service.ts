import api from "./api";
export type ConnectionProvider = "META" | "TIKTOK" | "X" | "LINKEDIN";
export interface SocialProviderOption { provider: ConnectionProvider; label: string; available: boolean; reason?: string }
export async function fetchSocialProviderOptions(): Promise<SocialProviderOption[]> {
  const { data } = await api.get("/api/v1/marketing/social/connections/providers");
  return data.data;
}
export async function startSocialAuthorization(provider: ConnectionProvider, connectionId?: string): Promise<void> {
  const path = connectionId ? `/api/v1/marketing/social/connections/${connectionId}/reauthorize` : `/api/v1/marketing/social/connections/${provider}/oauth/start`;
  const { data } = await api.post(path, {});
  const url = new URL(data.data.authorizationUrl);
  const expected = { META: "www.facebook.com", TIKTOK: "www.tiktok.com", X: "x.com", LINKEDIN: "www.linkedin.com" }[provider];
  if (url.protocol !== "https:" || url.hostname !== expected || url.username || url.password) throw new Error("The provider returned an invalid sign-in address.");
  window.location.assign(url.toString());
}
