import api from "./api";
import type {
  CampaignListResponse,
  CampaignDetail,
  CampaignMutationResult,
  CampaignPerformance,
  CampaignTimelineItem,
  CampaignTeamMember,
  CreateCampaignPayload,
  UpdateCampaignPayload,
  CampaignListQuery,
  CampaignStatus,
  ContentListResponse,
  ContentDetail,
  ContentMutationResult,
  ContentPerformance,
  CreateContentPayload,
  UpdateContentPayload,
  ContentListQuery,
  ContentReportQuery,
  ContentReportResult,
  EmailTemplateListResponse,
  EmailTemplateDetail,
  EmailTemplateCreateResult,
  EmailTemplateVersion,
  CreateEmailTemplatePayload,
  UpdateEmailTemplatePayload,
  EmailTemplateRecipientsPayload,
  EmailTemplateContentPayload,
  EmailTemplateListQuery,
  EmailTemplateCustomerSearchResult,
  SocialOverview,
  SocialAccount,
  CreateSocialAccountPayload,
  SocialPostListItem,
  SocialPostDetail,
  SocialPostsListQuery,
  CreateSocialPostPayload,
  UpdateSocialPostPayload,
  SocialSchedule,
  SocialScheduleQuery,
  CreateSocialSchedulePayload,
  SocialInsightsQuery,
  SocialInsightItem,
  PromotionListResponse,
  PromotionMutationResult,
  CreatePromotionPayload,
  UpdatePromotionPayload,
  PromotionListQuery,
  BannerListResponse,
  BannerDetail,
  BannerMutationResult,
  CreateBannerPayload,
  UpdateBannerPayload,
  BannerListQuery,
  BannerStatus,
  AnalyticsDateRangeQuery,
  AnalyticsOverviewStats,
  AnalyticsSocialStats,
  AnalyticsAdsPerformance,
  AnalyticsLocationResponse,
  AnalyticsAudienceBreakdown,
  AnalyticsConversionFunnel,
  AnalyticsWeeklyEngagement,
  AnalyticsPerformanceData,
  AnalyticsPlatformIntegrationsResponse,
} from "@/types/marketing.types";

const BASE = "/api/marketing";

/**
 * NOTE on response shapes (verified against marketing.controller.js):
 * - GET (list/detail) endpoints respond with the raw payload directly
 *   (no `{success, data}` envelope) -> `return data;`
 * - POST/PUT/PATCH mutations that return a resource respond with
 *   `{ message, data }` -> `return data.data;`
 * - DELETE and a few PUT/PATCH (recipients, content) only return
 *   `{ message }` -> void
 * This differs from the admin-ops service, which wraps everything in `data.data`.
 */

// ─── Campaigns ────────────────────────────────────────────────────────────────

export const fetchCampaigns = async (
  params: CampaignListQuery,
): Promise<CampaignListResponse> => {
  const { data } = await api.get(`${BASE}/campaigns`, { params });
  return data;
};

export const fetchCampaign = async (id: string): Promise<CampaignDetail> => {
  const { data } = await api.get(`${BASE}/campaigns/${id}`);
  return data;
};

export const fetchCampaignPerformance = async (
  id: string,
): Promise<CampaignPerformance> => {
  const { data } = await api.get(`${BASE}/campaigns/${id}/performance`);
  return data;
};

export const fetchCampaignTimeline = async (
  id: string,
): Promise<{ timeline: CampaignTimelineItem[] }> => {
  const { data } = await api.get(`${BASE}/campaigns/${id}/timeline`);
  return data;
};

export const fetchCampaignTeam = async (
  id: string,
): Promise<{ team: CampaignTeamMember[] }> => {
  const { data } = await api.get(`${BASE}/campaigns/${id}/team`);
  return data;
};

export const createCampaign = async (
  payload: CreateCampaignPayload,
): Promise<{ id: string; title: string; status: CampaignStatus }> => {
  const { data } = await api.post(`${BASE}/campaigns`, payload);
  return data.data;
};

export const updateCampaign = async (
  id: string,
  payload: UpdateCampaignPayload,
): Promise<CampaignMutationResult> => {
  const { data } = await api.put(`${BASE}/campaigns/${id}`, payload);
  return data.data;
};

export const deleteCampaign = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/campaigns/${id}`);
};

export const updateCampaignStatus = async (
  id: string,
  status: CampaignStatus,
): Promise<{ status: CampaignStatus }> => {
  const { data } = await api.patch(`${BASE}/campaigns/${id}/status`, { status });
  return data.data;
};

export const duplicateCampaign = async (
  id: string,
): Promise<{ id: string; title: string }> => {
  const { data } = await api.post(`${BASE}/campaigns/${id}/duplicate`);
  return data.data;
};

// ─── Content Manager ──────────────────────────────────────────────────────────

export const fetchContentItems = async (
  params: ContentListQuery,
): Promise<ContentListResponse> => {
  const { data } = await api.get(`${BASE}/content`, { params });
  return data;
};

export const fetchContentById = async (id: string): Promise<ContentDetail> => {
  const { data } = await api.get(`${BASE}/content/${id}`);
  return data;
};

export const fetchContentPerformance = async (
  id: string,
): Promise<ContentPerformance> => {
  const { data } = await api.get(`${BASE}/content/${id}/performance`);
  return data;
};

export const createContent = async (
  payload: CreateContentPayload,
): Promise<{ id: string; title: string; status: string }> => {
  const { data } = await api.post(`${BASE}/content`, payload);
  return data.data;
};

export const updateContent = async (
  id: string,
  payload: UpdateContentPayload,
): Promise<ContentMutationResult> => {
  const { data } = await api.put(`${BASE}/content/${id}`, payload);
  return data.data;
};

export const deleteContent = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/content/${id}`);
};

// Backend streams a raw CSV file (text/csv + Content-Disposition), not JSON.
export const fetchContentReport = async (
  id: string,
  params: ContentReportQuery = {},
): Promise<ContentReportResult> => {
  const response = await api.get(`${BASE}/content/${id}/report`, {
    params,
    responseType: "blob",
  });

  const disposition = String(response.headers["content-disposition"] || "");
  const match = disposition.match(/filename="?([^"]+)"?/);

  return {
    filename: match?.[1] || `marketing-content-${id}.csv`,
    blob: response.data,
  };
};

// ─── Email Templates ──────────────────────────────────────────────────────────

export const fetchEmailTemplates = async (
  params: EmailTemplateListQuery,
): Promise<EmailTemplateListResponse> => {
  const { data } = await api.get(`${BASE}/email-templates`, { params });
  return data;
};

export const fetchEmailTemplateById = async (
  id: string,
): Promise<EmailTemplateDetail> => {
  const { data } = await api.get(`${BASE}/email-templates/${id}`);
  return data;
};

export const createEmailTemplate = async (
  payload: CreateEmailTemplatePayload,
): Promise<EmailTemplateCreateResult> => {
  const { data } = await api.post(`${BASE}/email-templates`, payload);
  return data.data;
};

export const updateEmailTemplate = async (
  id: string,
  payload: UpdateEmailTemplatePayload,
): Promise<EmailTemplateVersion> => {
  const { data } = await api.put(`${BASE}/email-templates/${id}`, payload);
  return data.data;
};

export const deleteEmailTemplate = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/email-templates/${id}`);
};

export const updateEmailTemplateNotification = async (
  id: string,
  notifyEnabled: boolean,
): Promise<{ notifyEnabled: boolean }> => {
  const { data } = await api.patch(`${BASE}/email-templates/${id}/notification`, {
    notifyEnabled,
  });
  return data.data;
};

export const updateEmailTemplateRecipients = async (
  id: string,
  payload: EmailTemplateRecipientsPayload,
): Promise<void> => {
  await api.patch(`${BASE}/email-templates/${id}/recipients`, payload);
};

export const updateEmailTemplateContent = async (
  id: string,
  payload: EmailTemplateContentPayload,
): Promise<void> => {
  await api.put(`${BASE}/email-templates/${id}/content`, payload);
};

export const searchEmailTemplateCustomers = async (
  query: string,
): Promise<EmailTemplateCustomerSearchResult> => {
  const { data } = await api.get(`${BASE}/email-templates/customers/search`, {
    params: { query },
  });
  return data;
};

// ─── Social Media ─────────────────────────────────────────────────────────────

export const fetchSocialOverview = async (): Promise<SocialOverview> => {
  const { data } = await api.get(`${BASE}/social/overview`);
  return data;
};

export const fetchSocialAccounts = async (): Promise<{ data: SocialAccount[] }> => {
  const { data } = await api.get(`${BASE}/social/accounts`);
  return data;
};

export const createSocialAccount = async (
  payload: CreateSocialAccountPayload,
): Promise<{ id: string; platform: string }> => {
  const { data } = await api.post(`${BASE}/social/accounts`, payload);
  return data.data;
};

export const deleteSocialAccount = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/social/accounts/${id}`);
};

export const fetchSocialPosts = async (
  params: SocialPostsListQuery,
): Promise<{ data: SocialPostListItem[] }> => {
  const { data } = await api.get(`${BASE}/social/posts`, { params });
  return data;
};

export const createSocialPost = async (
  payload: CreateSocialPostPayload,
): Promise<{ id: string; platform: string }> => {
  const { data } = await api.post(`${BASE}/social/posts`, payload);
  return data.data;
};

export const fetchSocialPostById = async (id: string): Promise<SocialPostDetail> => {
  const { data } = await api.get(`${BASE}/social/posts/${id}`);
  return data;
};

export const updateSocialPost = async (
  id: string,
  payload: UpdateSocialPostPayload,
): Promise<void> => {
  await api.put(`${BASE}/social/posts/${id}`, payload);
};

export const deleteSocialPost = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/social/posts/${id}`);
};

export const fetchSocialSchedule = async (
  params: SocialScheduleQuery,
): Promise<SocialSchedule> => {
  const { data } = await api.get(`${BASE}/social/schedule`, { params });
  return data;
};

export const createSocialSchedule = async (
  payload: CreateSocialSchedulePayload,
): Promise<{ id: string }> => {
  const { data } = await api.post(`${BASE}/social/schedule`, payload);
  return data.data;
};

export const fetchSocialInsights = async (
  params: SocialInsightsQuery,
): Promise<{ data: SocialInsightItem[] }> => {
  const { data } = await api.get(`${BASE}/social/insights`, { params });
  return data;
};

// ─── Promotions ───────────────────────────────────────────────────────────────

export const fetchPromotions = async (
  params: PromotionListQuery,
): Promise<PromotionListResponse> => {
  const { data } = await api.get(`${BASE}/promotions`, { params });
  return data;
};

export const createPromotion = async (
  payload: CreatePromotionPayload,
): Promise<{ id: string; status: string }> => {
  const { data } = await api.post(`${BASE}/promotions`, payload);
  return data.data;
};

export const updatePromotion = async (
  id: string,
  payload: UpdatePromotionPayload,
): Promise<PromotionMutationResult> => {
  const { data } = await api.put(`${BASE}/promotions/${id}`, payload);
  return data.data;
};

export const deletePromotion = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/promotions/${id}`);
};

// ─── Banners ──────────────────────────────────────────────────────────────────

function buildBannerFormData<T extends object>(payload: T): FormData {
  const formData = new FormData();

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;

    if (key === "file" && value instanceof File) {
      formData.append("file", value);
      continue;
    }

    if (Array.isArray(value)) {
      formData.append(key, JSON.stringify(value));
      continue;
    }

    formData.append(key, String(value));
  }

  return formData;
}

export const fetchBanners = async (
  params: BannerListQuery,
): Promise<BannerListResponse> => {
  const { data } = await api.get(`${BASE}/banners`, { params });
  return data;
};

export const fetchBannerById = async (id: string): Promise<BannerDetail> => {
  const { data } = await api.get(`${BASE}/banners/${id}`);
  return data;
};

export const createBanner = async (
  payload: CreateBannerPayload,
): Promise<{ id: string; status: BannerStatus }> => {
  const formData = buildBannerFormData(payload);
  const { data } = await api.post(`${BASE}/banners`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data.data;
};

export const updateBanner = async (
  id: string,
  payload: UpdateBannerPayload,
): Promise<BannerMutationResult> => {
  const formData = buildBannerFormData(payload);
  const { data } = await api.put(`${BASE}/banners/${id}`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data.data;
};

export const deleteBanner = async (id: string): Promise<void> => {
  await api.delete(`${BASE}/banners/${id}`);
};

export const updateBannerStatus = async (
  id: string,
  status: BannerStatus,
): Promise<{ status: BannerStatus }> => {
  const { data } = await api.patch(`${BASE}/banners/${id}/status`, { status });
  return data.data;
};

// ─── Analytics ────────────────────────────────────────────────────────────────

export const fetchAnalyticsOverviewStats = async (
  params: AnalyticsDateRangeQuery = {},
): Promise<AnalyticsOverviewStats> => {
  const { data } = await api.get(`${BASE}/analytics/overview-stats`, { params });
  return data;
};

export const fetchAnalyticsSocialStats = async (
  params: AnalyticsDateRangeQuery = {},
): Promise<AnalyticsSocialStats> => {
  const { data } = await api.get(`${BASE}/analytics/social-stats`, { params });
  return data;
};

export const fetchAnalyticsAdsPerformance = async (
  params: AnalyticsDateRangeQuery = {},
): Promise<AnalyticsAdsPerformance> => {
  const { data } = await api.get(`${BASE}/analytics/ads-performance`, { params });
  return data;
};

export const fetchAnalyticsLocation = async (
  params: AnalyticsDateRangeQuery = {},
): Promise<AnalyticsLocationResponse> => {
  const { data } = await api.get(`${BASE}/analytics/location`, { params });
  return data;
};

export const fetchAnalyticsAudienceBreakdown = async (
  params: AnalyticsDateRangeQuery = {},
): Promise<AnalyticsAudienceBreakdown> => {
  const { data } = await api.get(`${BASE}/analytics/audience-breakdown`, { params });
  return data;
};

export const fetchAnalyticsConversionFunnel = async (
  params: AnalyticsDateRangeQuery = {},
): Promise<AnalyticsConversionFunnel> => {
  const { data } = await api.get(`${BASE}/analytics/conversion-funnel`, { params });
  return data;
};

export const fetchAnalyticsWeeklyEngagement = async (
  params: AnalyticsDateRangeQuery = {},
): Promise<AnalyticsWeeklyEngagement> => {
  const { data } = await api.get(`${BASE}/analytics/weekly-engagement`, { params });
  return data;
};

export const fetchAnalyticsPerformanceData = async (
  params: AnalyticsDateRangeQuery = {},
): Promise<AnalyticsPerformanceData> => {
  const { data } = await api.get(`${BASE}/analytics/performance-data`, { params });
  return data;
};

export const fetchAnalyticsPlatformIntegrations = async (
  params: AnalyticsDateRangeQuery = {},
): Promise<AnalyticsPlatformIntegrationsResponse> => {
  const { data } = await api.get(`${BASE}/analytics/platform-integrations`, {
    params,
  });
  return data;
};