// ─── Enums ───────────────────────────────────────────────────────────────────

export type ServiceStatus = "up" | "down" | "degraded" | "unknown";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "dead_letter";
export type JobType = "cron" | "background" | "scheduled" | "manual";
export type DeadLetterStatus = "pending_retry" | "exhausted" | "manually_resolved";
export type WebhookDeliveryStatus = "success" | "failed" | "pending";
export type IncidentSeverity = "critical" | "high" | "medium" | "low";
export type IncidentStatus = "open" | "investigating" | "identified" | "monitoring" | "resolved" | "closed";
export type AlertType = "job_failure" | "health_degraded" | "dead_letter" | "webhook_failure" | "custom";
export type AlertSeverity = "critical" | "warning" | "info";

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface AdminOpsPagination {
  currentPage: number;
  totalPages: number;
  totalItems: number;
}

export interface AdminOpsListResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface AdminOpsFilters {
  search: string;
  status: string;
  page: number;
  limit: number;
}

// ─── Service Registry ─────────────────────────────────────────────────────────

export interface ServiceRegistry {
  id: string;
  name: string;
  displayName: string;
  baseUrl: string | null;
  healthEndpoint: string | null;
  status: ServiceStatus;
  version: string | null;
  tags: string[] | null;
  metadata: Record<string, any> | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  responseTimeMs?: number;
}

export interface RegisterServicePayload {
  name: string;
  displayName: string;
  baseUrl?: string;
  healthEndpoint?: string;
  version?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

// ─── Job Monitoring ───────────────────────────────────────────────────────────

export interface JobExecution {
  id: string;
  jobName: string;
  jobType: JobType;
  status: JobStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  input: Record<string, any> | null;
  output: Record<string, any> | null;
  error: string | null;
  attempts: number;
  scheduledAt: string | null;
  createdAt: string;
}

export interface TrackJobPayload {
  jobName: string;
  jobType: JobType;
  status: JobStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  input?: Record<string, any>;
  output?: Record<string, any>;
  error?: string;
  attempts?: number;
}

// ─── Dead Letter Jobs ─────────────────────────────────────────────────────────

export interface DeadLetterJob {
  id: string;
  jobExecutionId: string | null;
  jobName: string;
  payload: Record<string, any> | null;
  errorMessage: string | null;
  failedAt: string;
  retryCount: number;
  maxRetries: number;
  status: DeadLetterStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Webhook Endpoints ────────────────────────────────────────────────────────

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  events: string[] | null;
  isActive: boolean;
  provider: string | null;
  headers: Record<string, string> | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookPayload {
  name: string;
  url: string;
  events?: string[];
  isActive?: boolean;
  provider?: string;
  secret?: string;
  headers?: Record<string, string>;
  description?: string;
}

// ─── Webhook Delivery Logs ────────────────────────────────────────────────────

export interface WebhookDeliveryLog {
  id: string;
  webhookEndpointId: string | null;
  event: string;
  payload: Record<string, any> | null;
  statusCode: number | null;
  responseBody: string | null;
  attempt: number;
  status: WebhookDeliveryStatus;
  deliveredAt: string | null;
  error: string | null;
  provider: string | null;
  createdAt: string;
}

// ─── Incidents ────────────────────────────────────────────────────────────────

export interface Incident {
  id: string;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  affectedServices: string[] | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdBy: string | null;
  metadata: Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentPayload {
  title: string;
  description?: string;
  severity: IncidentSeverity;
  affectedServices?: string[];
  metadata?: Record<string, any>;
}

// ─── System Alerts ────────────────────────────────────────────────────────────

export interface SystemAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  details: Record<string, any> | null;
  source: string | null;
  isRead: boolean;
  isResolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AlertPayload {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  details?: Record<string, any>;
  source?: string;
}

// ─── Feature Flags ────────────────────────────────────────────────────────────

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  enabledFor: string[] | null;
  rolloutPercentage: number | null;
  environment: string;
  metadata: Record<string, any> | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureFlagPayload {
  key: string;
  name: string;
  description?: string;
  isEnabled?: boolean;
  enabledFor?: string[];
  rolloutPercentage?: number;
  environment?: string;
  metadata?: Record<string, any>;
}

export interface FlagCheckResult {
  key: string;
  isEnabled: boolean;
  environment: string;
  rolloutPercentage: number | null;
}

// ─── Health History ───────────────────────────────────────────────────────────

export interface HealthCheckRecord {
  id: string;
  status: string;
  version: string | null;
  environment: string | null;
  uptime: number | null;
  details: Record<string, any> | null;
  responseTimeMs: number | null;
  checkedAt: string;
  createdAt: string;
}

// ─── Environment Configs ──────────────────────────────────────────────────────

export interface EnvConfig {
  id: string;
  key: string;
  value: string | null;
  description: string | null;
  isPublic: boolean;
  environment: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnvConfigPayload {
  key: string;
  value?: string;
  description?: string;
  isPublic?: boolean;
  environment?: string;
}