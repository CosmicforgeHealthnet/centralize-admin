import api from "./api";
import type {
  ITStats,
  Consultation,
  RTCSession,
  Delivery,
  Transaction,
  AuditLog,
  UserNotification,
  Pagination,
} from "@/types/it.types";

interface ListResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export const fetchITStats = async (): Promise<ITStats> => {
  const [telemedicine, rtc, logistics, payments, audit, notifications] = await Promise.all([
    api.get("/api/telemedicine/stats"),
    api.get("/api/rtc/stats"),
    api.get("/api/logistics/stats"),
    api.get("/api/payments/stats"),
    api.get("/api/audit-service/stats"),
    api.get("/api/notifications-service/stats"),
  ]);

  return {
    telemedicine: telemedicine.data.data,
    rtc: rtc.data.data,
    logistics: logistics.data.data,
    payments: payments.data.data,
    audit: audit.data.data,
    notifications: notifications.data.data,
  };
};

export const fetchConsultations = async (params: {
  status?: string;
  search?: string;
  page: number;
  limit: number;
}): Promise<ListResponse<Consultation>> => {
  const { data } = await api.get("/api/telemedicine", { params });
  return data.data;
};

export const transitionConsultation = async (id: string, status: string): Promise<void> => {
  await api.patch(`/api/telemedicine/${id}/status`, { status });
};

export const fetchRTCSessions = async (params: {
  status?: string;
  page: number;
  limit: number;
}): Promise<ListResponse<RTCSession>> => {
  const { data } = await api.get("/api/rtc", { params });
  return data.data;
};

export const transitionRTCSession = async (id: string, status: string): Promise<void> => {
  await api.patch(`/api/rtc/${id}/status`, { status });
};

export const fetchDeliveries = async (params: {
  status?: string;
  page: number;
  limit: number;
}): Promise<ListResponse<Delivery>> => {
  const { data } = await api.get("/api/logistics", { params });
  return data.data;
};

export const transitionDelivery = async (id: string, status: string): Promise<void> => {
  await api.patch(`/api/logistics/${id}/status`, { status });
};

export const retryDelivery = async (id: string): Promise<void> => {
  await api.post(`/api/logistics/${id}/retry`);
};

export const fetchTransactions = async (params: {
  status?: string;
  serviceType?: string;
  page: number;
  limit: number;
}): Promise<ListResponse<Transaction>> => {
  const { data } = await api.get("/api/payments", { params });
  return data.data;
};

export const transitionPayment = async (id: string, status: string): Promise<void> => {
  await api.patch(`/api/payments/${id}/status`, { status });
};

export const flagTransaction = async (id: string, reason: string): Promise<void> => {
  await api.post(`/api/payments/${id}/flag`, { reason });
};

export const fetchAuditLogs = async (params: {
  resourceType?: string;
  action?: string;
  page: number;
  limit: number;
}): Promise<ListResponse<AuditLog>> => {
  const { data } = await api.get("/api/audit-service", { params });
  return data.data;
};

export const fetchUserNotifications = async (
  userId: string,
  params: { page: number; limit: number }
): Promise<ListResponse<UserNotification>> => {
  const { data } = await api.get(`/api/notifications-service/user/${userId}`, { params });
  return data.data;
};