import api from "./api";
import type {
  IntegrationEvent,
  IntegrationHealth,
  IntegrationSender,
  MailAddressRef,
  MailOrganizationRef,
  ProductIntegration,
  SenderPurpose,
} from "@/types/mail-integrations.types";

const BASE = "/api/mail/v1/admin";

async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const { data } = await api.get<{ data: T }>(`${BASE}${url}`, { params });
  return data.data;
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const { data } = await api.post<{ data: T }>(`${BASE}${url}`, body ?? {});
  return data.data;
}

export const listIntegrations = () => get<ProductIntegration[]>("/integrations");
export const integrationHealth = (id: string) => get<IntegrationHealth>(`/integrations/${id}/health`);
export const integrationEvents = (id: string, status?: string) => get<IntegrationEvent[]>(`/integrations/${id}/events`, { status, limit: 50 });
export const integrationSenders = (id: string) => get<IntegrationSender[]>(`/integrations/${id}/senders`);
export const listMailOrganizations = () => get<MailOrganizationRef[]>("/organizations");
export const listOrganizationAddresses = (organizationId: string) => get<MailAddressRef[]>("/addresses", { organizationId });

export const createIntegration = (input: { product: string; serviceName: string; organizationId: string; allowedEventTypes: string[]; allowedTriggerTypes: string[] }) =>
  post<ProductIntegration>("/integrations", input);
export const updateIntegration = async (id: string, input: { allowedEventTypes?: string[]; allowedTriggerTypes?: string[] }) =>
  (await api.patch<{ data: ProductIntegration }>(`${BASE}/integrations/${id}`, input)).data.data;
export const activateIntegration = (id: string, input: { ownerApprovalReference: string; ownerApprovedBy: string; stepUpId: string }) =>
  post<ProductIntegration>(`/integrations/${id}/activate`, input);
export const suspendIntegration = (id: string, reason: string) => post<ProductIntegration>(`/integrations/${id}/suspend`, { reason });
export const authorizeIntegrationSender = (id: string, addressId: string, purpose: SenderPurpose) =>
  post<IntegrationSender>(`/integrations/${id}/senders`, { addressId, purpose });
export const revokeIntegrationSender = async (id: string, senderId: string) =>
  (await api.delete<{ data: { revoked: boolean } }>(`${BASE}/integrations/${id}/senders/${senderId}`)).data.data;
