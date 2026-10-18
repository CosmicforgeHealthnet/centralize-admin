import api from "./api";
import type {
  MIApiEnvelope,
  MIConnection,
  MIConnectionTestResult,
  MICreateConnectionPayload,
  MIUpdateConnectionPayload,
  MIPerformanceQuery,
  MIPerformanceResponse,
  MIProviderValidationRow,
  MISyncRequest,
  MISyncResult,
} from "@/types/marketing-intelligence.types";
import {
  delay,
  mockMIConnections,
  mockMIConnectionTest,
  mockMIPerformanceSingleCurrency,
  mockMIPerformanceMixedCurrency,
  mockMISyncResult,
  mockMIProviderValidation,
} from "./marketing-intelligence.mock";

// Flip to false once the backend is wired up in this environment.
// Nothing else in the app should need to change — same function signatures either way.
const USE_MOCK = false;

const BASE = "/api/v1/marketing/intelligence";

// ─── Connections ─────────────────────────────────────────────────────────────

export const fetchMIConnections = async (): Promise<MIConnection[]> => {
  if (USE_MOCK) {
    await delay();
    return mockMIConnections;
  }
  const { data } = await api.get<MIApiEnvelope<MIConnection[]>>(`${BASE}/connections`);
  return data.data;
};

export const fetchMIConnection = async (id: string): Promise<MIConnection> => {
  if (USE_MOCK) {
    await delay();
    const conn = mockMIConnections.find((c) => c.id === id);
    if (!conn) throw new Error("Connection not found");
    return conn;
  }
  const { data } = await api.get<MIApiEnvelope<MIConnection>>(`${BASE}/connections/${id}`);
  return data.data;
};

export const createMIConnection = async (payload: MICreateConnectionPayload): Promise<MIConnection> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockMIConnections[0], id: "mi-conn-new-" + Date.now(), platform: payload.platform };
  }
  const { data } = await api.post<MIApiEnvelope<MIConnection>>(`${BASE}/connections`, payload);
  return data.data;
};

export const updateMIConnection = async (id: string, payload: MIUpdateConnectionPayload): Promise<MIConnection> => {
  if (USE_MOCK) {
    await delay();
    const conn = mockMIConnections.find((c) => c.id === id);
    if (!conn) throw new Error("Connection not found");
    return { ...conn, ...payload, credentials: undefined } as MIConnection;
  }
  const { data } = await api.patch<MIApiEnvelope<MIConnection>>(`${BASE}/connections/${id}`, payload);
  return data.data;
};

export const testMIConnection = async (id: string): Promise<MIConnectionTestResult> => {
  if (USE_MOCK) {
    await delay(800);
    return mockMIConnectionTest(id);
  }
  const { data } = await api.post<MIApiEnvelope<MIConnectionTestResult>>(`${BASE}/connections/${id}/test`);
  return data.data;
};
export const disableMIConnection = async (id: string): Promise<void> => {
  if (USE_MOCK) {
    await delay();
    return;
  }
  await api.post(`${BASE}/connections/${id}/disable`);
};

export const enableMIConnection = async (id: string): Promise<void> => {
  if (USE_MOCK) {
    await delay();
    return;
  }
  await api.post(`${BASE}/connections/${id}/enable`);
};

export const deleteMIConnection = async (id: string): Promise<void> => {
  if (USE_MOCK) {
    await delay();
    return;
  }
  await api.delete(`${BASE}/connections/${id}`);
};

export const bootstrapMIConnections = async (): Promise<void> => {
  if (USE_MOCK) {
    await delay(1000);
    return;
  }
  await api.post(`${BASE}/connections/bootstrap`);
};

// ─── Performance dashboard (MI-01) ────────────────────────────────────────────

export const fetchMIPerformance = async (query: MIPerformanceQuery): Promise<MIPerformanceResponse> => {
  if (USE_MOCK) {
    await delay();
    // Toggle by platform filter just to exercise both dashboard states in dev.
    return query.platform === "LINKEDIN" ? mockMIPerformanceMixedCurrency : mockMIPerformanceSingleCurrency;
  }
  const { data } = await api.get<MIApiEnvelope<MIPerformanceResponse>>(`${BASE}/performance`, { params: query });
  return data.data;
};

// ─── Manual sync (MI-03) ───────────────────────────────────────────────────────

export const runMISync = async (payload: MISyncRequest): Promise<MISyncResult> => {
  if (USE_MOCK) {
    await delay(1500);
    return mockMISyncResult();
  }
  const { data } = await api.post<MIApiEnvelope<MISyncResult>>(`${BASE}/sync`, payload);
  return data.data;
};

// ─── Provider validation ─────────────────────────────────────────────────────

export const fetchMIProviderValidation = async (): Promise<MIProviderValidationRow[]> => {
  if (USE_MOCK) {
    await delay();
    return mockMIProviderValidation;
  }
  const { data } = await api.get<MIApiEnvelope<MIProviderValidationRow[]>>(`${BASE}/provider-validation`);
  return data.data;
};

// ─── OAuth ───────────────────────────────────────────────────────────────────

export const getMIOAuthStartUrl = (platform: string) => `${BASE}/oauth/${platform}/start`;