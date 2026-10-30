export type AuditAction =
  | "LOGIN"
  | "LOGOUT"
  | "LOGIN_FAILED"
  | "ACCOUNT_LOCKED"
  | "PASSWORD_CHANGED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET_COMPLETED"
  | "USER_CREATED"
  | "USER_UPDATED"
  | "USER_DEACTIVATED"
  | "USER_ACTIVATED"
  | "USER_DELETED"
  | "TICKET_RESOLVED"
  | "TICKET_ASSIGNED"
  | "TICKET_UPDATED"
  | "PAYMENT_VIEWED"
  | "APPOINTMENT_VIEWED"
  | "TOKEN_REFRESHED"
  | "PROFILE_UPDATED"
  | "DOCUMENT_UPLOADED"
  | "DOCUMENT_DELETED"
  | "AVATAR_UPDATED";

export interface ActivityLog {
  id: string;
  userId: string;
  userName: string;
  userAvatar: string | null;
  action: AuditAction;
  description: string;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
  time: string;
}

export interface LogGroup {
  date: string;
  logs: ActivityLog[];
}

export interface PaginationInfo {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ActivityLogsResponse {
  logs: ActivityLog[];
  pagination: PaginationInfo;
}