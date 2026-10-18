import api from "./api";
import type {
  AdminOpsListResponse,
  ServiceRegistry,
  RegisterServicePayload,
  JobExecution,
  TrackJobPayload,
  DeadLetterJob,
  WebhookEndpoint,
  WebhookPayload,
  WebhookDeliveryLog,
  Incident,
  IncidentPayload,
  SystemAlert,
  AlertPayload,
  FeatureFlag,
  FeatureFlagPayload,
  FlagCheckResult,
  HealthCheckRecord,
  EnvConfig,
  EnvConfigPayload,
} from "@/types/admin-ops.types";

const BASE = "/api/admin/ops";

// ─── Service Registry ─────────────────────────────────────────────────────────

export const fetchServices = async (params: {
  status?: string;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<ServiceRegistry>> => {
  const { data } = await api.get(`${BASE}/services`, { params });
  return data.data;
};

export const fetchService = async (id: string): Promise<ServiceRegistry> => {
  const { data } = await api.get(`${BASE}/services/${id}`);
  return data.data;
};

export const registerService = async (payload: RegisterServicePayload): Promise<ServiceRegistry> => {
  const { data } = await api.post(`${BASE}/services`, payload);
  return data.data;
};

export const updateService = async (id: string, payload: Partial<RegisterServicePayload>): Promise<ServiceRegistry> => {
  const { data } = await api.put(`${BASE}/services/${id}`, payload);
  return data.data;
};

export const deregisterService = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/services/${id}`);
};

export const pingService = async (id: string): Promise<ServiceRegistry & { responseTimeMs: number }> => {
  const { data } = await api.post(`${BASE}/services/${id}/ping`);
  return data.data;
};

// ─── Job Monitoring ───────────────────────────────────────────────────────────

export const fetchJobs = async (params: {
  status?: string;
  jobType?: string;
  jobName?: string;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<JobExecution>> => {
  const { data } = await api.get(`${BASE}/jobs`, { params });
  return data.data;
};

export const fetchJob = async (id: string): Promise<JobExecution> => {
  const { data } = await api.get(`${BASE}/jobs/${id}`);
  return data.data;
};

export const trackJob = async (payload: TrackJobPayload): Promise<JobExecution> => {
  const { data } = await api.post(`${BASE}/jobs/track`, payload);
  return data.data;
};

// ─── Dead Letter Jobs ─────────────────────────────────────────────────────────

export const fetchDeadLetters = async (params: {
  status?: string;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<DeadLetterJob>> => {
  const { data } = await api.get(`${BASE}/dead-letters`, { params });
  return data.data;
};

export const fetchDeadLetter = async (id: string): Promise<DeadLetterJob> => {
  const { data } = await api.get(`${BASE}/dead-letters/${id}`);
  return data.data;
};

export const resolveDeadLetter = async (id: string): Promise<DeadLetterJob> => {
  const { data } = await api.put(`${BASE}/dead-letters/${id}/resolve`);
  return data.data;
};

// ─── Webhook Endpoints ────────────────────────────────────────────────────────

export const fetchWebhooks = async (params: {
  isActive?: boolean;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<WebhookEndpoint>> => {
  const { data } = await api.get(`${BASE}/webhooks`, { params });
  return data.data;
};

export const fetchWebhook = async (id: string): Promise<WebhookEndpoint> => {
  const { data } = await api.get(`${BASE}/webhooks/${id}`);
  return data.data;
};

export const createWebhook = async (payload: WebhookPayload): Promise<WebhookEndpoint> => {
  const { data } = await api.post(`${BASE}/webhooks`, payload);
  return data.data;
};

export const updateWebhook = async (id: string, payload: Partial<WebhookPayload>): Promise<WebhookEndpoint> => {
  const { data } = await api.put(`${BASE}/webhooks/${id}`, payload);
  return data.data;
};

export const deleteWebhook = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/webhooks/${id}`);
};

// ─── Webhook Delivery Logs ────────────────────────────────────────────────────

export const fetchWebhookLogs = async (params: {
  webhookEndpointId?: string;
  status?: string;
  event?: string;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<WebhookDeliveryLog>> => {
  const { data } = await api.get(`${BASE}/webhook-logs`, { params });
  return data.data;
};

export const fetchWebhookLog = async (id: string): Promise<WebhookDeliveryLog> => {
  const { data } = await api.get(`${BASE}/webhook-logs/${id}`);
  return data.data;
};

// ─── Incidents ────────────────────────────────────────────────────────────────

export const fetchIncidents = async (params: {
  status?: string;
  severity?: string;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<Incident>> => {
  const { data } = await api.get(`${BASE}/incidents`, { params });
  return data.data;
};

export const fetchIncident = async (id: string): Promise<Incident> => {
  const { data } = await api.get(`${BASE}/incidents/${id}`);
  return data.data;
};

export const createIncident = async (payload: IncidentPayload): Promise<Incident> => {
  const { data } = await api.post(`${BASE}/incidents`, payload);
  return data.data;
};

export const updateIncident = async (id: string, payload: Partial<IncidentPayload & { status: string }>): Promise<Incident> => {
  const { data } = await api.put(`${BASE}/incidents/${id}`, payload);
  return data.data;
};

export const resolveIncident = async (id: string): Promise<Incident> => {
  const { data } = await api.post(`${BASE}/incidents/${id}/resolve`);
  return data.data;
};

// ─── System Alerts ────────────────────────────────────────────────────────────

export const fetchAlerts = async (params: {
  isResolved?: boolean;
  isRead?: boolean;
  severity?: string;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<SystemAlert>> => {
  const { data } = await api.get(`${BASE}/alerts`, { params });
  return data.data;
};

export const fetchAlert = async (id: string): Promise<SystemAlert> => {
  const { data } = await api.get(`${BASE}/alerts/${id}`);
  return data.data;
};

export const createAlert = async (payload: AlertPayload): Promise<SystemAlert> => {
  const { data } = await api.post(`${BASE}/alerts`, payload);
  return data.data;
};

export const markAlertRead = async (id: string): Promise<SystemAlert> => {
  const { data } = await api.put(`${BASE}/alerts/${id}/read`);
  return data.data;
};

export const resolveAlert = async (id: string): Promise<SystemAlert> => {
  const { data } = await api.put(`${BASE}/alerts/${id}/resolve`);
  return data.data;
};

// ─── Feature Flags ────────────────────────────────────────────────────────────

export const fetchFlags = async (params: {
  environment?: string;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<FeatureFlag>> => {
  const { data } = await api.get(`${BASE}/flags`, { params });
  return data.data;
};

export const fetchFlag = async (key: string): Promise<FeatureFlag> => {
  const { data } = await api.get(`${BASE}/flags/${key}`);
  return data.data;
};

export const createFlag = async (payload: FeatureFlagPayload): Promise<FeatureFlag> => {
  const { data } = await api.post(`${BASE}/flags`, payload);
  return data.data;
};

export const updateFlag = async (key: string, payload: Partial<FeatureFlagPayload>): Promise<FeatureFlag> => {
  const { data } = await api.put(`${BASE}/flags/${key}`, payload);
  return data.data;
};

export const deleteFlag = async (key: string): Promise<void> => {
  await api.delete(`${BASE}/flags/${key}`);
};

export const checkFlag = async (key: string): Promise<FlagCheckResult> => {
  const { data } = await api.get(`${BASE}/flags/${key}/check`);
  return data.data;
};

// ─── Health History ───────────────────────────────────────────────────────────

export const fetchHealthHistory = async (params: {
  status?: string;
  environment?: string;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<HealthCheckRecord>> => {
  const { data } = await api.get(`${BASE}/health-history`, { params });
  return data.data;
};

export const fetchLatestHealthCheck = async (): Promise<HealthCheckRecord> => {
  const { data } = await api.get(`${BASE}/health-history/latest`);
  return data.data;
};

// ─── Environment Configs ──────────────────────────────────────────────────────

export const fetchEnvConfigs = async (params: {
  environment?: string;
  page: number;
  limit: number;
}): Promise<AdminOpsListResponse<EnvConfig>> => {
  const { data } = await api.get(`${BASE}/env-configs`, { params });
  return data.data;
};

export const createEnvConfig = async (payload: EnvConfigPayload): Promise<EnvConfig> => {
  const { data } = await api.post(`${BASE}/env-configs`, payload);
  return data.data;
};

export const updateEnvConfig = async (id: string, payload: Partial<EnvConfigPayload>): Promise<EnvConfig> => {
  const { data } = await api.put(`${BASE}/env-configs/${id}`, payload);
  return data.data;
};

export const deleteEnvConfig = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/env-configs/${id}`);
};