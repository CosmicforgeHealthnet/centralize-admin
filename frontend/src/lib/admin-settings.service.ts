import api from "./api";
import type {
  AdminSetting,
  AdminSettingsGrouped,
  UpdateSettingPayload,
  BatchUpdatePayload,
  SettingHistory,
  SettingHistoryFilters,
  SettingsListResponse,
} from "@/types/admin-settings.types";

const BASE = "/api/admin-settings";

// ─── Settings CRUD ───────────────────────────────────────────────────────────

export const fetchAllSettings = async (): Promise<AdminSettingsGrouped> => {
  const { data } = await api.get(`${BASE}/all`);
  return data.data;
};

export const fetchSettingsByCategory = async (category: string): Promise<AdminSetting[]> => {
  const { data } = await api.get(`${BASE}/category/${category}`);
  return data.data;
};

export const fetchSetting = async (category: string, key: string): Promise<AdminSetting> => {
  const { data } = await api.get(`${BASE}/${category}/${key}`);
  return data.data;
};

export const updateSetting = async (category: string, key: string, value: unknown): Promise<AdminSetting> => {
  const { data } = await api.put(`${BASE}/${category}/${key}`, { value });
  return data.data;
};

export const batchUpdateSettings = async (updates: UpdateSettingPayload[]): Promise<AdminSetting[]> => {
  const { data } = await api.put(`${BASE}/batch`, { updates });
  return data.data;
};

// ─── History / Audit ──────────────────────────────────────────────────────────

export const fetchSettingsHistory = async (params: SettingHistoryFilters): Promise<SettingsListResponse<SettingHistory>> => {
  const queryParams: Record<string, unknown> = {};
  if (params.category) queryParams.category = params.category;
  if (params.key) queryParams.key = params.key;
  if (params.changedBy) queryParams.changedBy = params.changedBy;
  if (params.page) queryParams.page = params.page;
  if (params.limit) queryParams.limit = params.limit;
  
  const { data } = await api.get(`${BASE}/history`, { params: queryParams });
  return data.data;
};

export const fetchSettingHistory = async (settingId: string, page?: number, limit?: number): Promise<SettingsListResponse<SettingHistory>> => {
  const { data } = await api.get(`${BASE}/history/${settingId}`, { params: { page, limit } });
  return data.data;
};