import api from "./api";
import type {
  AdminDomain,
  AdminMailbox,
  AdminOrganization,
  AdminRetentionPolicy,
  LegalHold,
  MailAuditEvent,
  MailDeliveryEventRow,
  MailJobRow,
  MailWebhookEventRow,
  ProvisionRequest,
  ProvisionRequestInput,
  SenderGrant,
} from "@/types/mail-admin.types";

// Mail administration for IT (domains, mailboxes, approvals, grants, legal
// holds, audits) and HR provisioning requests. Every call is authorized
// server-side; the UI only reflects what the API allows.

const BASE = "/api/mail/v1";
const unwrap = <T>(response: { data: { data: T } }) => response.data.data;

export const listOrganizations = async () => unwrap<AdminOrganization[]>(await api.get(`${BASE}/admin/organizations`));
export const createOrganization = async (input: { slug: string; name: string; kind: "COMPANY" | "BRAND" }) =>
  unwrap<AdminOrganization>(await api.post(`${BASE}/admin/organizations`, input));

export const listDomains = async () => unwrap<AdminDomain[]>(await api.get(`${BASE}/admin/domains`));
export const createDomain = async (input: { organizationId: string; domain: string; providerDomainId?: string }) =>
  unwrap<AdminDomain>(await api.post(`${BASE}/admin/domains`, input));
export const verifyDomain = async (domainId: string) => unwrap<AdminDomain>(await api.post(`${BASE}/admin/domains/${domainId}/verify`, {}));

export const listMailboxes = async () => unwrap<AdminMailbox[]>(await api.get(`${BASE}/admin/mailboxes`));
export const createSharedMailbox = async (input: { organizationId: string; name: string; purpose: string; domainId: string; localPart: string; displayName?: string }) =>
  unwrap<AdminMailbox>(
    await api.post(`${BASE}/admin/mailboxes`, {
      organizationId: input.organizationId,
      type: "SHARED",
      name: input.name,
      purpose: input.purpose,
      address: { domainId: input.domainId, localPart: input.localPart, displayName: input.displayName || input.name },
    }),
  );
export const createPersonalMailbox = async (input: { organizationId: string; ownerAdminUserId: string; name: string; domainId: string; localPart: string }) =>
  unwrap<AdminMailbox>(
    await api.post(`${BASE}/admin/mailboxes`, {
      organizationId: input.organizationId,
      ownerAdminUserId: input.ownerAdminUserId,
      type: "PERSONAL",
      name: input.name,
      purpose: "GENERAL",
      address: { domainId: input.domainId, localPart: input.localPart, displayName: input.name },
    }),
  );

export const setMailboxStatus = async (mailboxId: string, action: "suspend" | "reactivate") =>
  unwrap<AdminMailbox>(await api.post(`${BASE}/admin/mailboxes/${mailboxId}/${action}`, {}));

export const listProvisionRequests = async () => unwrap<ProvisionRequest[]>(await api.get(`${BASE}/provisioning/requests`));
export const createProvisionRequest = async (input: ProvisionRequestInput) => unwrap<ProvisionRequest>(await api.post(`${BASE}/provisioning/requests`, input));
export const decideProvisionRequest = async (requestId: string, approve: boolean, note?: string) =>
  unwrap<ProvisionRequest>(await api.post(`${BASE}/provisioning/requests/${requestId}/${approve ? "approve" : "reject"}`, { note }));

export const listSenderGrants = async (mailboxId?: string) =>
  unwrap<SenderGrant[]>(await api.get(`${BASE}/admin/sender-grants`, { params: mailboxId ? { mailboxId } : {} }));
export const createSenderGrant = async (input: { mailboxId: string; addressId: string; adminUserId: string; expiresAt?: string }) =>
  unwrap<SenderGrant>(await api.post(`${BASE}/admin/sender-grants`, input));
export const revokeSenderGrant = async (grantId: string) => unwrap<{ revoked: boolean }>(await api.delete(`${BASE}/admin/sender-grants/${grantId}`));

export const listLegalHolds = async () => unwrap<LegalHold[]>(await api.get(`${BASE}/admin/legal-holds`));
export const createLegalHold = async (input: { organizationId: string; mailboxId?: string; reason: string }) =>
  unwrap<LegalHold>(await api.post(`${BASE}/admin/legal-holds`, input));
export const releaseLegalHold = async (holdId: string) => unwrap<LegalHold>(await api.post(`${BASE}/admin/legal-holds/${holdId}/release`, {}));

export const listRetentionPolicies = async () => unwrap<AdminRetentionPolicy[]>(await api.get(`${BASE}/admin/retention-policies`));
export const createRetentionPolicy = async (input: { organizationId: string; mailboxId?: string; name: string; retainDays: number; action: "ARCHIVE" | "DELETE" }) =>
  unwrap<AdminRetentionPolicy>(await api.post(`${BASE}/admin/retention-policies`, input));

export const listAuditEvents = async (params: { action?: string; targetId?: string; before?: string } = {}) =>
  unwrap<MailAuditEvent[]>(await api.get(`${BASE}/admin/audit-events`, { params }));
export const listWebhookEvents = async (params: { status?: string } = {}) => unwrap<MailWebhookEventRow[]>(await api.get(`${BASE}/admin/webhook-events`, { params }));
export const listDeliveryEvents = async () => unwrap<MailDeliveryEventRow[]>(await api.get(`${BASE}/admin/delivery-events`));
export const listJobs = async (params: { status?: string } = {}) => unwrap<MailJobRow[]>(await api.get(`${BASE}/admin/jobs`, { params }));
