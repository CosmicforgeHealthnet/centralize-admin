import api from "./api";
import type {
  Audience,
  Block,
  Brand,
  Campaign,
  CampaignHistory,
  CampaignInput,
  Consent,
  ConsentInput,
  Contact,
  ContactInput,
  EmailTemplate,
  ImportReport,
  LegacyTemplate,
  MarketingSenderIdentity,
  AudienceMembershipResult,
  MarketingOrganization,
  PreflightResult,
  RenderResult,
  Segment,
  SegmentPreview,
  Suppression,
  TemplateVersion,
} from "@/types/mail-marketing.types";
import type {
  ApprovedProductEvent,
  Automation,
  AutomationDefinition,
  AutomationEnrollment,
  AutomationTrigger,
  AutomationVersion,
  BrandSettings,
  BroadcastDispatch,
  BroadcastRecipient,
  BroadcastReport,
  DispatchState,
  MarketingOverview,
} from "@/types/mail-marketing.types";
import type { Paged } from "@/types/mail.types";

const BASE = "/api/mail/v1/marketing";

interface Envelope<T> {
  data: T;
  meta?: { nextCursor?: string | null };
}

const get = async <T>(url: string, params?: Record<string, unknown>) =>
  (await api.get<Envelope<T>>(`${BASE}${url}`, { params })).data.data;
const getPaged = async <T>(url: string, params?: Record<string, unknown>): Promise<Paged<T>> => {
  const { data } = await api.get<Envelope<T[]>>(`${BASE}${url}`, { params });
  return { items: data.data ?? [], nextCursor: data.meta?.nextCursor ?? null };
};
const post = async <T>(url: string, body?: unknown) => (await api.post<Envelope<T>>(`${BASE}${url}`, body ?? {})).data.data;
const patch = async <T>(url: string, body: unknown) => (await api.patch<Envelope<T>>(`${BASE}${url}`, body)).data.data;
const del = async <T>(url: string, body?: unknown) => (await api.delete<Envelope<T>>(`${BASE}${url}`, { data: body })).data.data;

export const fetchMarketingOrganizations = () => get<MarketingOrganization[]>("/organizations");

// Contacts & consent
export const fetchContacts = (orgId: string, params: { q?: string; status?: string; cursor?: string | null } = {}) =>
  getPaged<Contact>(`/${orgId}/contacts`, { ...params, cursor: params.cursor ?? undefined });
export const fetchContact = (orgId: string, contactId: string) => get<Contact>(`/${orgId}/contacts/${contactId}`);
export const createContact = (orgId: string, body: ContactInput) => post<Contact>(`/${orgId}/contacts`, body);
export const updateContact = (orgId: string, contactId: string, body: Partial<ContactInput>) =>
  patch<Contact>(`/${orgId}/contacts/${contactId}`, body);
export const recordConsent = (orgId: string, contactId: string, body: ConsentInput) =>
  post<Consent>(`/${orgId}/contacts/${contactId}/consents`, body);
export const withdrawConsent = (orgId: string, contactId: string, topic: string) =>
  post<Consent>(`/${orgId}/contacts/${contactId}/consents/${encodeURIComponent(topic)}/withdraw`);

export async function importContacts(
  orgId: string,
  file: File,
  fields: { topic: string; source: string; policyVersion: string; evidenceReference: string; audienceId?: string },
): Promise<ImportReport> {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  const { data } = await api.post<Envelope<ImportReport>>(`${BASE}/${orgId}/contacts/import`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data.data;
}

export const fetchSuppressions = (orgId: string) => getPaged<Suppression>(`/${orgId}/suppressions`);
export const createSuppression = (orgId: string, body: { email: string; reason: string; note?: string }) =>
  post<Suppression>(`/${orgId}/suppressions`, body);
export const liftSuppression = (orgId: string, id: string) => post<Suppression>(`/${orgId}/suppressions/${id}/lift`);

// Audiences & segments
export const fetchAudiences = (orgId: string) => getPaged<Audience>(`/${orgId}/audiences`);
export const fetchAudience = (orgId: string, audienceId: string) => get<Audience>(`/${orgId}/audiences/${audienceId}`);
export const createAudience = (orgId: string, body: { name: string; description?: string; topic: string }) =>
  post<Audience>(`/${orgId}/audiences`, body);
export const updateAudience = (orgId: string, audienceId: string, body: { name?: string; description?: string }) =>
  patch<Audience>(`/${orgId}/audiences/${audienceId}`, body);
export const addAudienceContacts = (orgId: string, audienceId: string, contactIds: string[]) =>
  post<AudienceMembershipResult>(`/${orgId}/audiences/${audienceId}/contacts`, { contactIds });
export const removeAudienceContacts = (orgId: string, audienceId: string, contactIds: string[]) =>
  del<AudienceMembershipResult>(`/${orgId}/audiences/${audienceId}/contacts`, { contactIds });
export const fetchSenderIdentities = (orgId: string) => get<MarketingSenderIdentity[]>(`/${orgId}/sender-identities`);
export const fetchSegments = (orgId: string, audienceId: string) => get<Segment[]>(`/${orgId}/audiences/${audienceId}/segments`);
export const createSegment = (orgId: string, audienceId: string, body: { name: string; definition: Segment["definition"] }) =>
  post<Segment>(`/${orgId}/audiences/${audienceId}/segments`, body);
export const previewSegment = (orgId: string, segmentId: string) => get<SegmentPreview>(`/${orgId}/segments/${segmentId}/preview`);

// Templates
export const fetchTemplates = (orgId: string) => getPaged<EmailTemplate>(`/${orgId}/templates`);
export const fetchTemplate = (orgId: string, templateId: string) => get<EmailTemplate>(`/${orgId}/templates/${templateId}`);
export const createTemplate = (orgId: string, body: { name: string; description?: string; legacyTemplateId?: string }) =>
  post<EmailTemplate>(`/${orgId}/templates`, body);
export const createTemplateVersion = (
  orgId: string,
  templateId: string,
  body: { subject: string; preheader?: string; blocks: Block[]; brand?: Brand },
) => post<TemplateVersion>(`/${orgId}/templates/${templateId}/versions`, body);
export const renderTemplate = (
  orgId: string,
  body: { subject: string; blocks: Block[]; brand?: Brand; sampleData?: Record<string, string> },
) => post<RenderResult>(`/${orgId}/templates/render`, body);
export const fetchLegacyTemplates = (orgId: string) => get<LegacyTemplate[]>(`/${orgId}/legacy-templates`);

// Campaigns
export const fetchCampaigns = (orgId: string, params: { status?: string } = {}) => getPaged<Campaign>(`/${orgId}/campaigns`, params);
export const fetchCampaign = (orgId: string, campaignId: string) => get<Campaign>(`/${orgId}/campaigns/${campaignId}`);
export const createCampaign = (orgId: string, body: CampaignInput & { name: string; topic: string }) =>
  post<Campaign>(`/${orgId}/campaigns`, body);
export const updateCampaign = (orgId: string, campaignId: string, body: CampaignInput & { revision: number }) =>
  patch<Campaign>(`/${orgId}/campaigns/${campaignId}`, body);
export const preflightCampaign = (orgId: string, campaignId: string) =>
  post<PreflightResult>(`/${orgId}/campaigns/${campaignId}/preflight`);
export const submitCampaign = (orgId: string, campaignId: string, revision: number) =>
  post<Campaign>(`/${orgId}/campaigns/${campaignId}/submit`, { revision });
export const approveCampaign = (orgId: string, campaignId: string, body: { revision: number; stepUpId: string; comment?: string }) =>
  post<Campaign>(`/${orgId}/campaigns/${campaignId}/approve`, body);
export const rejectCampaign = (orgId: string, campaignId: string, body: { revision: number; comment: string }) =>
  post<Campaign>(`/${orgId}/campaigns/${campaignId}/reject`, body);
export const fetchCampaignHistory = (orgId: string, campaignId: string) =>
  get<CampaignHistory>(`/${orgId}/campaigns/${campaignId}/history`);

// ── M7: brand settings, broadcasts, reporting ─────────────────────────────

const put = async <T>(url: string, body: unknown) => (await api.put<Envelope<T>>(`${BASE}${url}`, body)).data.data;

export const fetchBrandSettings = (orgId: string) => get<BrandSettings>(`/${orgId}/settings`);
export const updateBrandSettings = (orgId: string, body: Partial<Omit<BrandSettings, "provider" | "flags">>) => patch<BrandSettings>(`/${orgId}/settings`, body);
export const pauseBrandDispatch = (orgId: string, reason: string) => post<BrandSettings>(`/${orgId}/dispatch/pause`, { reason });
export const resumeBrandDispatch = (orgId: string, stepUpId: string) => post<BrandSettings>(`/${orgId}/dispatch/resume`, { stepUpId });

export const scheduleCampaign = (orgId: string, campaignId: string, body: { revision: number; sendAt?: string; timeZone?: string; sendAtUtc?: string }) =>
  post<BroadcastDispatch>(`/${orgId}/campaigns/${campaignId}/schedule`, body);
export const cancelDispatch = (orgId: string, campaignId: string, reason?: string) => post<BroadcastDispatch>(`/${orgId}/campaigns/${campaignId}/cancel`, { reason });
export const pauseDispatch = (orgId: string, campaignId: string) => post<BroadcastDispatch>(`/${orgId}/campaigns/${campaignId}/pause`);
export const resumeDispatch = (orgId: string, campaignId: string) => post<BroadcastDispatch>(`/${orgId}/campaigns/${campaignId}/resume`);
export const fetchDispatch = (orgId: string, campaignId: string) => get<DispatchState>(`/${orgId}/campaigns/${campaignId}/dispatch`);
export const fetchBroadcastReport = (orgId: string, campaignId: string) => get<BroadcastReport>(`/${orgId}/campaigns/${campaignId}/report`);
export const fetchBroadcastRecipients = (orgId: string, campaignId: string, params: { status?: string; cursor?: string | null } = {}) =>
  getPaged<BroadcastRecipient>(`/${orgId}/campaigns/${campaignId}/recipients`, { ...params, cursor: params.cursor ?? undefined });
export const fetchMarketingOverview = (orgId: string) => get<MarketingOverview>(`/${orgId}/reports/overview`);

// ── M7: automation ────────────────────────────────────────────────────────
export const fetchApprovedProductEvents = (orgId: string) => get<ApprovedProductEvent[]>(`/${orgId}/automation-events`);
export const fetchAutomations = (orgId: string) => get<Automation[]>(`/${orgId}/automations`);
export const fetchAutomation = (orgId: string, id: string) => get<Automation>(`/${orgId}/automations/${id}`);
export const createAutomation = (orgId: string, body: { name: string; triggerType: AutomationTrigger; description?: string; frequencyCapHours?: number; enrollmentLimit?: number }) =>
  post<Automation>(`/${orgId}/automations`, body);
export const saveAutomationDraft = (orgId: string, id: string, body: { definition: AutomationDefinition; triggerConfig: Record<string, unknown> }) =>
  put<AutomationVersion>(`/${orgId}/automations/${id}/draft`, body);
export const submitAutomationVersion = (orgId: string, id: string, versionId: string) => post<AutomationVersion>(`/${orgId}/automations/${id}/versions/${versionId}/submit`);
export const approveAutomationVersion = (orgId: string, id: string, versionId: string, body: { stepUpId: string; definitionSha256: string; comment?: string }) =>
  post<Automation>(`/${orgId}/automations/${id}/versions/${versionId}/approve`, body);
export const rejectAutomationVersion = (orgId: string, id: string, versionId: string, comment: string) =>
  post<AutomationVersion>(`/${orgId}/automations/${id}/versions/${versionId}/reject`, { comment });
export const activateAutomation = (orgId: string, id: string) => post<Automation>(`/${orgId}/automations/${id}/activate`);
export const pauseAutomation = (orgId: string, id: string) => post<Automation>(`/${orgId}/automations/${id}/pause`);
export const archiveAutomation = (orgId: string, id: string) => post<Automation>(`/${orgId}/automations/${id}/archive`);
export const fetchAutomationEnrollments = (orgId: string, id: string, params: { status?: string; cursor?: string | null } = {}) =>
  getPaged<AutomationEnrollment>(`/${orgId}/automations/${id}/enrollments`, { ...params, cursor: params.cursor ?? undefined });
