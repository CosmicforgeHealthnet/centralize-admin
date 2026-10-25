import api from "./api";

export interface MfaStatus {
  enrolled: boolean;
  enrolledAt: string | null;
  pending: boolean;
  recoveryCodesRemaining: number;
  lockedUntil: string | null;
  available: boolean;
}

export interface EnrollmentStart {
  secret: string;
  otpauthUri: string;
  expiresAt: string;
}

export interface ActiveSession {
  id: string;
  authMethod: string;
  mode: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  mfaVerifiedAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

export type Factor = { code?: string; recoveryCode?: string };

const data = <T,>(res: { data: { data: T } }) => res.data.data;

export const accountSecurity = {
  mfaStatus: () => api.get("/api/auth/mfa/status").then(data<MfaStatus>),
  startEnrollment: (password: string) => api.post("/api/auth/mfa/enroll", { password }).then(data<EnrollmentStart>),
  activate: (code: string) => api.post("/api/auth/mfa/activate", { code }).then(data<{ recoveryCodes: string[] }>),
  stepUp: (factor: Factor) => api.post("/api/auth/mfa/step-up", factor).then(data<{ verifiedAt: string }>),
  regenerateRecoveryCodes: () => api.post("/api/auth/mfa/recovery-codes/regenerate", {}).then(data<{ recoveryCodes: string[] }>),
  disable: (password: string, factor: Factor) => api.post("/api/auth/mfa/disable", { password, ...factor }).then(data<{ disabled: boolean }>),
  listSessions: () => api.get("/api/auth/sessions").then(data<ActiveSession[]>),
  revokeSession: (id: string) => api.delete(`/api/auth/sessions/${encodeURIComponent(id)}`),
  logoutAll: () => api.post("/api/auth/logout-all", {}),
};

export function errorCode(err: unknown): string | undefined {
  return (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
}

export function errorMessage(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;
}
