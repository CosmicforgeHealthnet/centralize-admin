import { create } from "zustand";
import type {
  CampaignListItem,
  CampaignStats,
  CampaignDetail,
  CampaignTimelineItem,
  CampaignTeamMember,
  CampaignFilters,
  CreateCampaignPayload,
  UpdateCampaignPayload,
  CampaignStatus,
  ContentListItem,
  ContentCounts,
  ContentDetail,
  ContentPerformancePoint,
  ContentFilters,
  CreateContentPayload,
  UpdateContentPayload,
  EmailTemplateListItem,
  EmailTemplateDetail,
  EmailTemplateFilters,
  CreateEmailTemplatePayload,
  UpdateEmailTemplatePayload,
  EmailTemplateRecipientsPayload,
  EmailTemplateContentPayload,
  SocialOverview,
  SocialAccount,
  CreateSocialAccountPayload,
  SocialPostListItem,
  SocialPostDetail,
  SocialPostFilters,
  CreateSocialPostPayload,
  UpdateSocialPostPayload,
  SocialSchedule,
  SocialScheduleQuery,
  CreateSocialSchedulePayload,
  SocialInsightsQuery,
  SocialInsightItem,
  PromotionListItem,
  PromotionStats,
  PromotionFilters,
  CreatePromotionPayload,
  UpdatePromotionPayload,
  BannerListItem,
  BannerDetail,
  BannerFilters,
  CreateBannerPayload,
  UpdateBannerPayload,
  BannerStatus,
  AnalyticsDateRangeQuery,
  AnalyticsOverviewStats,
  AnalyticsSocialStats,
  AnalyticsAdsPerformance,
  AnalyticsLocationItem,
  AnalyticsAudienceBreakdown,
  AnalyticsConversionFunnel,
  AnalyticsWeeklyEngagement,
  AnalyticsPerformanceData,
  AnalyticsPlatformIntegration,
  MarketingPagination,
  MarketingMeta,
} from "@/types/marketing.types";
import {
  fetchCampaigns, fetchCampaign, fetchCampaignPerformance, fetchCampaignTimeline, fetchCampaignTeam,
  createCampaign, updateCampaign, deleteCampaign, updateCampaignStatus, duplicateCampaign,
  fetchContentItems, fetchContentById, fetchContentPerformance, createContent, updateContent,
  deleteContent, fetchContentReport,
  fetchEmailTemplates, fetchEmailTemplateById, createEmailTemplate, updateEmailTemplate,
  deleteEmailTemplate, updateEmailTemplateNotification, updateEmailTemplateRecipients,
  updateEmailTemplateContent,
  fetchSocialOverview, fetchSocialAccounts, createSocialAccount, deleteSocialAccount,
  fetchSocialPosts, createSocialPost, fetchSocialPostById, updateSocialPost, deleteSocialPost,
  fetchSocialSchedule, createSocialSchedule, fetchSocialInsights,
  fetchPromotions, createPromotion, updatePromotion, deletePromotion,
  fetchBanners, fetchBannerById, createBanner, updateBanner, deleteBanner, updateBannerStatus,
  fetchAnalyticsOverviewStats, fetchAnalyticsSocialStats, fetchAnalyticsAdsPerformance,
  fetchAnalyticsLocation, fetchAnalyticsAudienceBreakdown, fetchAnalyticsConversionFunnel,
  fetchAnalyticsWeeklyEngagement, fetchAnalyticsPerformanceData, fetchAnalyticsPlatformIntegrations,
} from "@/lib/marketing.service";

// ── Shared error extraction helper ──────────────────────────────────────────
function extractErrorMessage(err: any, fallback: string): string {
  const data = err.response?.data;
  if (data?.errors?.length) {
    return data.errors.map((e: any) => e.message).join(", ");
  }
  return data?.message || fallback;
}

// Backend already computes totalPages, so this just reshapes the field names.
const buildPagination = (meta: MarketingMeta): MarketingPagination => ({
  currentPage: meta.page,
  totalPages: meta.totalPages,
  totalItems: meta.total,
});

const defaultCampaignFilters: CampaignFilters = { search: "", status: "", type: "", page: 1, limit: 9 };
const defaultContentFilters: ContentFilters = { search: "", status: "", page: 1, limit: 15 };
const defaultEmailTemplateFilters: EmailTemplateFilters = { search: "", page: 1, limit: 15 };
const defaultSocialPostFilters: SocialPostFilters = { platform: "All", page: 1, limit: 15 };
const defaultPromotionFilters: PromotionFilters = { search: "", tab: "All", page: 1, limit: 15 };
const defaultBannerFilters: BannerFilters = { search: "", page: 1, limit: 15 };

function downloadBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

interface MarketingState {
  // ── Campaigns ──────────────────────────────────────────────────────────────
  campaigns: CampaignListItem[];
  campaignStats: CampaignStats | null;
  campaignPagination: MarketingPagination | null;
  campaignFilters: CampaignFilters;
  isLoadingCampaigns: boolean;
  selectedCampaign: CampaignDetail | null;
  campaignTimeline: CampaignTimelineItem[];
  campaignTeam: CampaignTeamMember[];
  isLoadingCampaignDetail: boolean;

  // ── Content ────────────────────────────────────────────────────────────────
  contentItems: ContentListItem[];
  contentCounts: ContentCounts | null;
  contentPagination: MarketingPagination | null;
  contentFilters: ContentFilters;
  isLoadingContent: boolean;
  selectedContent: ContentDetail | null;
  contentPerformance: ContentPerformancePoint[];
  isLoadingContentDetail: boolean;

  // ── Email Templates ────────────────────────────────────────────────────────
  emailTemplates: EmailTemplateListItem[];
  emailTemplatePagination: MarketingPagination | null;
  emailTemplateFilters: EmailTemplateFilters;
  isLoadingEmailTemplates: boolean;
  selectedEmailTemplate: EmailTemplateDetail | null;
  isLoadingEmailTemplateDetail: boolean;

  // ── Social Media ───────────────────────────────────────────────────────────
  socialOverview: SocialOverview | null;
  isLoadingSocialOverview: boolean;
  socialAccounts: SocialAccount[];
  isLoadingSocialAccounts: boolean;
  socialPosts: SocialPostListItem[];
  socialPostFilters: SocialPostFilters;
  isLoadingSocialPosts: boolean;
  selectedSocialPost: SocialPostDetail | null;
  isLoadingSocialPostDetail: boolean;
  socialSchedule: SocialSchedule | null;
  socialScheduleQuery: SocialScheduleQuery;
  isLoadingSocialSchedule: boolean;
  socialInsights: SocialInsightItem[];
  socialInsightsQuery: SocialInsightsQuery;
  isLoadingSocialInsights: boolean;

  // ── Promotions ─────────────────────────────────────────────────────────────
  promotions: PromotionListItem[];
  promotionStats: PromotionStats | null;
  promotionPagination: MarketingPagination | null;
  promotionFilters: PromotionFilters;
  isLoadingPromotions: boolean;

  // ── Banners ────────────────────────────────────────────────────────────────
  banners: BannerListItem[];
  bannerPagination: MarketingPagination | null;
  bannerFilters: BannerFilters;
  isLoadingBanners: boolean;
  selectedBanner: BannerDetail | null;
  isLoadingBannerDetail: boolean;

  // ── Analytics ──────────────────────────────────────────────────────────────
  analyticsDateRange: AnalyticsDateRangeQuery;
  analyticsOverviewStats: AnalyticsOverviewStats | null;
  analyticsSocialStats: AnalyticsSocialStats | null;
  analyticsAdsPerformance: AnalyticsAdsPerformance | null;
  analyticsLocation: AnalyticsLocationItem[];
  analyticsAudienceBreakdown: AnalyticsAudienceBreakdown | null;
  analyticsConversionFunnel: AnalyticsConversionFunnel | null;
  analyticsWeeklyEngagement: AnalyticsWeeklyEngagement | null;
  analyticsPerformanceData: AnalyticsPerformanceData | null;
  analyticsPlatformIntegrations: AnalyticsPlatformIntegration[];
  isLoadingAnalytics: boolean;

  actionLoading: string | null;
  error: string | null;

  // ── Campaign actions ───────────────────────────────────────────────────────
  fetchCampaigns: () => Promise<void>;
  setCampaignFilters: (f: Partial<CampaignFilters>) => void;
  fetchCampaignDetail: (id: string) => Promise<void>;
  createCampaign: (payload: CreateCampaignPayload) => Promise<void>;
  updateCampaign: (id: string, payload: UpdateCampaignPayload) => Promise<void>;
  deleteCampaign: (id: string) => Promise<void>;
  updateCampaignStatus: (id: string, status: CampaignStatus) => Promise<void>;
  duplicateCampaign: (id: string) => Promise<void>;

  // ── Content actions ────────────────────────────────────────────────────────
  fetchContentItems: () => Promise<void>;
  setContentFilters: (f: Partial<ContentFilters>) => void;
  fetchContentDetail: (id: string) => Promise<void>;
  createContent: (payload: CreateContentPayload) => Promise<void>;
  updateContent: (id: string, payload: UpdateContentPayload) => Promise<void>;
  deleteContent: (id: string) => Promise<void>;
  downloadContentReport: (id: string, format?: "csv" | "pdf") => Promise<void>;

  // ── Email template actions ─────────────────────────────────────────────────
  fetchEmailTemplates: () => Promise<void>;
  setEmailTemplateFilters: (f: Partial<EmailTemplateFilters>) => void;
  fetchEmailTemplateDetail: (id: string) => Promise<void>;
  createEmailTemplate: (payload: CreateEmailTemplatePayload) => Promise<void>;
  updateEmailTemplate: (id: string, payload: UpdateEmailTemplatePayload) => Promise<void>;
  deleteEmailTemplate: (id: string) => Promise<void>;
  updateEmailTemplateNotification: (id: string, notifyEnabled: boolean) => Promise<void>;
  updateEmailTemplateRecipients: (id: string, payload: EmailTemplateRecipientsPayload) => Promise<void>;
  updateEmailTemplateContent: (id: string, payload: EmailTemplateContentPayload) => Promise<void>;

  // ── Social actions ─────────────────────────────────────────────────────────
  fetchSocialOverview: () => Promise<void>;
  fetchSocialAccounts: () => Promise<void>;
  createSocialAccount: (payload: CreateSocialAccountPayload) => Promise<void>;
  deleteSocialAccount: (id: string) => Promise<void>;
  fetchSocialPosts: () => Promise<void>;
  setSocialPostFilters: (f: Partial<SocialPostFilters>) => void;
  createSocialPost: (payload: CreateSocialPostPayload) => Promise<void>;
  fetchSocialPostDetail: (id: string) => Promise<void>;
  updateSocialPost: (id: string, payload: UpdateSocialPostPayload) => Promise<void>;
  deleteSocialPost: (id: string) => Promise<void>;
  fetchSocialSchedule: () => Promise<void>;
  setSocialScheduleQuery: (q: SocialScheduleQuery) => void;
  createSocialSchedule: (payload: CreateSocialSchedulePayload) => Promise<void>;
  fetchSocialInsights: () => Promise<void>;
  setSocialInsightsQuery: (q: SocialInsightsQuery) => void;

  // ── Promotion actions ──────────────────────────────────────────────────────
  fetchPromotions: () => Promise<void>;
  setPromotionFilters: (f: Partial<PromotionFilters>) => void;
  createPromotion: (payload: CreatePromotionPayload) => Promise<void>;
  updatePromotion: (id: string, payload: UpdatePromotionPayload) => Promise<void>;
  deletePromotion: (id: string) => Promise<void>;

  // ── Banner actions ─────────────────────────────────────────────────────────
  fetchBanners: () => Promise<void>;
  setBannerFilters: (f: Partial<BannerFilters>) => void;
  fetchBannerDetail: (id: string) => Promise<void>;
  createBanner: (payload: CreateBannerPayload) => Promise<void>;
  updateBanner: (id: string, payload: UpdateBannerPayload) => Promise<void>;
  deleteBanner: (id: string) => Promise<void>;
  updateBannerStatus: (id: string, status: BannerStatus) => Promise<void>;

  // ── Analytics actions ──────────────────────────────────────────────────────
  setAnalyticsDateRange: (range: AnalyticsDateRangeQuery) => void;
  fetchAnalyticsOverviewStats: () => Promise<void>;
  fetchAnalyticsSocialStats: () => Promise<void>;
  fetchAnalyticsAdsPerformance: () => Promise<void>;
  fetchAnalyticsLocation: () => Promise<void>;
  fetchAnalyticsAudienceBreakdown: () => Promise<void>;
  fetchAnalyticsConversionFunnel: () => Promise<void>;
  fetchAnalyticsWeeklyEngagement: () => Promise<void>;
  fetchAnalyticsPerformanceData: () => Promise<void>;
  fetchAnalyticsPlatformIntegrations: () => Promise<void>;
  fetchAllAnalytics: () => Promise<void>;

  clearError: () => void;
}

export const useMarketingStore = create<MarketingState>((set, get) => ({
  campaigns: [], campaignStats: null, campaignPagination: null,
  campaignFilters: { ...defaultCampaignFilters }, isLoadingCampaigns: false,
  selectedCampaign: null, campaignTimeline: [], campaignTeam: [], isLoadingCampaignDetail: false,

  contentItems: [], contentCounts: null, contentPagination: null,
  contentFilters: { ...defaultContentFilters }, isLoadingContent: false,
  selectedContent: null, contentPerformance: [], isLoadingContentDetail: false,

  emailTemplates: [], emailTemplatePagination: null,
  emailTemplateFilters: { ...defaultEmailTemplateFilters }, isLoadingEmailTemplates: false,
  selectedEmailTemplate: null, isLoadingEmailTemplateDetail: false,

  socialOverview: null, isLoadingSocialOverview: false,
  socialAccounts: [], isLoadingSocialAccounts: false,
  socialPosts: [], socialPostFilters: { ...defaultSocialPostFilters }, isLoadingSocialPosts: false,
  selectedSocialPost: null, isLoadingSocialPostDetail: false,
  socialSchedule: null, socialScheduleQuery: {}, isLoadingSocialSchedule: false,
  socialInsights: [], socialInsightsQuery: {}, isLoadingSocialInsights: false,

  promotions: [], promotionStats: null, promotionPagination: null,
  promotionFilters: { ...defaultPromotionFilters }, isLoadingPromotions: false,

  banners: [], bannerPagination: null, bannerFilters: { ...defaultBannerFilters },
  isLoadingBanners: false, selectedBanner: null, isLoadingBannerDetail: false,

  analyticsDateRange: {},
  analyticsOverviewStats: null,
  analyticsSocialStats: null,
  analyticsAdsPerformance: null,
  analyticsLocation: [],
  analyticsAudienceBreakdown: null,
  analyticsConversionFunnel: null,
  analyticsWeeklyEngagement: null,
  analyticsPerformanceData: null,
  analyticsPlatformIntegrations: [],
  isLoadingAnalytics: false,

  actionLoading: null,
  error: null,

  // ── Campaigns ──────────────────────────────────────────────────────────────
  fetchCampaigns: async () => {
    const { campaignFilters: f } = get();
    set({ isLoadingCampaigns: true, error: null });
    try {
      const res = await fetchCampaigns({
        search: f.search || undefined,
        status: f.status || undefined,
        type: f.type || undefined,
        page: f.page,
        limit: f.limit,
      });
      set({
        campaigns: res.data,
        campaignStats: res.stats,
        campaignPagination: buildPagination(res.meta),
        isLoadingCampaigns: false,
      });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch campaigns"), isLoadingCampaigns: false });
    }
  },
  setCampaignFilters: (f) => set((s) => ({ campaignFilters: { ...s.campaignFilters, ...f } })),
  fetchCampaignDetail: async (id) => {
    set({ isLoadingCampaignDetail: true, error: null });
    try {
      const [detail, timeline, team] = await Promise.all([
        fetchCampaign(id),
        fetchCampaignTimeline(id),
        fetchCampaignTeam(id),
      ]);
      set({
        selectedCampaign: detail,
        campaignTimeline: timeline.timeline,
        campaignTeam: team.team,
        isLoadingCampaignDetail: false,
      });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch campaign"), isLoadingCampaignDetail: false });
    }
  },
  createCampaign: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createCampaign(payload);
      await get().fetchCampaigns();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to create campaign"), actionLoading: null });
    }
  },
  updateCampaign: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateCampaign(id, payload);
      await get().fetchCampaigns();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update campaign"), actionLoading: null });
    }
  },
  deleteCampaign: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteCampaign(id);
      set((s) => ({ campaigns: s.campaigns.filter((c) => c.id !== id), actionLoading: null }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to delete campaign"), actionLoading: null });
    }
  },
  updateCampaignStatus: async (id, status) => {
    set({ actionLoading: id });
    try {
      await updateCampaignStatus(id, status);
      set((s) => ({
        campaigns: s.campaigns.map((c) => (c.id === id ? { ...c, status } : c)),
        selectedCampaign:
          s.selectedCampaign && s.selectedCampaign.id === id
            ? { ...s.selectedCampaign, status }
            : s.selectedCampaign,
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update campaign status"), actionLoading: null });
    }
  },
  duplicateCampaign: async (id) => {
    set({ actionLoading: id });
    try {
      await duplicateCampaign(id);
      await get().fetchCampaigns();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to duplicate campaign"), actionLoading: null });
    }
  },

  // ── Content ────────────────────────────────────────────────────────────────
  fetchContentItems: async () => {
    const { contentFilters: f } = get();
    set({ isLoadingContent: true, error: null });
    try {
      const res = await fetchContentItems({
        search: f.search || undefined,
        status: f.status || undefined,
        page: f.page,
        limit: f.limit,
      });
      set({
        contentItems: res.data,
        contentCounts: res.counts,
        contentPagination: buildPagination(res.meta),
        isLoadingContent: false,
      });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch content"), isLoadingContent: false });
    }
  },
  setContentFilters: (f) => set((s) => ({ contentFilters: { ...s.contentFilters, ...f } })),
  fetchContentDetail: async (id) => {
    set({ isLoadingContentDetail: true, error: null });
    try {
      const [detail, performance] = await Promise.all([
        fetchContentById(id),
        fetchContentPerformance(id),
      ]);
      set({
        selectedContent: detail,
        contentPerformance: performance.chartData,
        isLoadingContentDetail: false,
      });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch content item"), isLoadingContentDetail: false });
    }
  },
  createContent: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createContent(payload);
      await get().fetchContentItems();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to create content"), actionLoading: null });
    }
  },
  updateContent: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateContent(id, payload);
      await get().fetchContentItems();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update content"), actionLoading: null });
    }
  },
  deleteContent: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteContent(id);
      set((s) => ({ contentItems: s.contentItems.filter((c) => c.id !== id), actionLoading: null }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to delete content"), actionLoading: null });
    }
  },
  downloadContentReport: async (id, format) => {
    set({ actionLoading: `report-${id}` });
    try {
      const result = await fetchContentReport(id, { format });
      downloadBlob(result.blob, result.filename);
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to download report"), actionLoading: null });
    }
  },

  // ── Email Templates ────────────────────────────────────────────────────────
  fetchEmailTemplates: async () => {
    const { emailTemplateFilters: f } = get();
    set({ isLoadingEmailTemplates: true, error: null });
    try {
      const res = await fetchEmailTemplates({ search: f.search || undefined, page: f.page, limit: f.limit });
      set({
        emailTemplates: res.data,
        emailTemplatePagination: buildPagination(res.meta),
        isLoadingEmailTemplates: false,
      });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch email templates"), isLoadingEmailTemplates: false });
    }
  },
  setEmailTemplateFilters: (f) => set((s) => ({ emailTemplateFilters: { ...s.emailTemplateFilters, ...f } })),
  fetchEmailTemplateDetail: async (id) => {
    set({ isLoadingEmailTemplateDetail: true, error: null });
    try {
      const detail = await fetchEmailTemplateById(id);
      set({ selectedEmailTemplate: detail, isLoadingEmailTemplateDetail: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch email template"), isLoadingEmailTemplateDetail: false });
    }
  },
  createEmailTemplate: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createEmailTemplate(payload);
      await get().fetchEmailTemplates();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to create email template"), actionLoading: null });
    }
  },
  updateEmailTemplate: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateEmailTemplate(id, payload);
      await get().fetchEmailTemplates();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update email template"), actionLoading: null });
    }
  },
  deleteEmailTemplate: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteEmailTemplate(id);
      set((s) => ({ emailTemplates: s.emailTemplates.filter((e) => e.id !== id), actionLoading: null }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to delete email template"), actionLoading: null });
    }
  },
  updateEmailTemplateNotification: async (id, notifyEnabled) => {
    set({ actionLoading: id });
    try {
      await updateEmailTemplateNotification(id, notifyEnabled);
      set((s) => ({
        selectedEmailTemplate:
          s.selectedEmailTemplate && s.selectedEmailTemplate.id === id
            ? { ...s.selectedEmailTemplate, notifyEnabled }
            : s.selectedEmailTemplate,
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update notification setting"), actionLoading: null });
    }
  },
  updateEmailTemplateRecipients: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateEmailTemplateRecipients(id, payload);
      await get().fetchEmailTemplateDetail(id);
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update recipients"), actionLoading: null });
    }
  },
  updateEmailTemplateContent: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateEmailTemplateContent(id, payload);
      await get().fetchEmailTemplateDetail(id);
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to save template content"), actionLoading: null });
    }
  },

  // ── Social Media ───────────────────────────────────────────────────────────
  fetchSocialOverview: async () => {
    set({ isLoadingSocialOverview: true, error: null });
    try {
      const overview = await fetchSocialOverview();
      set({ socialOverview: overview, isLoadingSocialOverview: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch social overview"), isLoadingSocialOverview: false });
    }
  },
  fetchSocialAccounts: async () => {
    set({ isLoadingSocialAccounts: true, error: null });
    try {
      const res = await fetchSocialAccounts();
      set({ socialAccounts: res.data, isLoadingSocialAccounts: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch social accounts"), isLoadingSocialAccounts: false });
    }
  },
  createSocialAccount: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createSocialAccount(payload);
      await get().fetchSocialAccounts();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to link account"), actionLoading: null });
    }
  },
  deleteSocialAccount: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteSocialAccount(id);
      set((s) => ({ socialAccounts: s.socialAccounts.filter((a) => a.id !== id), actionLoading: null }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to unlink account"), actionLoading: null });
    }
  },
  fetchSocialPosts: async () => {
    const { socialPostFilters: f } = get();
    set({ isLoadingSocialPosts: true, error: null });
    try {
      const res = await fetchSocialPosts({ platform: f.platform, page: f.page, limit: f.limit });
      set({ socialPosts: res.data, isLoadingSocialPosts: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch posts"), isLoadingSocialPosts: false });
    }
  },
  setSocialPostFilters: (f) => set((s) => ({ socialPostFilters: { ...s.socialPostFilters, ...f } })),
  createSocialPost: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createSocialPost(payload);
      await get().fetchSocialPosts();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to send post"), actionLoading: null });
    }
  },
  fetchSocialPostDetail: async (id) => {
    set({ isLoadingSocialPostDetail: true, error: null });
    try {
      const detail = await fetchSocialPostById(id);
      set({ selectedSocialPost: detail, isLoadingSocialPostDetail: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch post"), isLoadingSocialPostDetail: false });
    }
  },
  updateSocialPost: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateSocialPost(id, payload);
      await get().fetchSocialPosts();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update post"), actionLoading: null });
    }
  },
  deleteSocialPost: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteSocialPost(id);
      set((s) => ({ socialPosts: s.socialPosts.filter((p) => p.id !== id), actionLoading: null }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to delete post"), actionLoading: null });
    }
  },
  fetchSocialSchedule: async () => {
    const { socialScheduleQuery: q } = get();
    set({ isLoadingSocialSchedule: true, error: null });
    try {
      const schedule = await fetchSocialSchedule(q);
      set({ socialSchedule: schedule, isLoadingSocialSchedule: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch schedule"), isLoadingSocialSchedule: false });
    }
  },
  setSocialScheduleQuery: (q) => set({ socialScheduleQuery: q }),
  createSocialSchedule: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createSocialSchedule(payload);
      await get().fetchSocialSchedule();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to schedule post"), actionLoading: null });
    }
  },
  fetchSocialInsights: async () => {
    const { socialInsightsQuery: q } = get();
    set({ isLoadingSocialInsights: true, error: null });
    try {
      const res = await fetchSocialInsights(q);
      set({ socialInsights: res.data, isLoadingSocialInsights: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch insights"), isLoadingSocialInsights: false });
    }
  },
  setSocialInsightsQuery: (q) => set({ socialInsightsQuery: q }),

  // ── Promotions ─────────────────────────────────────────────────────────────
  fetchPromotions: async () => {
    const { promotionFilters: f } = get();
    set({ isLoadingPromotions: true, error: null });
    try {
      const res = await fetchPromotions({ search: f.search || undefined, tab: f.tab, page: f.page, limit: f.limit });
      set({
        promotions: res.data,
        promotionStats: res.stats,
        promotionPagination: buildPagination(res.meta),
        isLoadingPromotions: false,
      });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch promotions"), isLoadingPromotions: false });
    }
  },
  setPromotionFilters: (f) => set((s) => ({ promotionFilters: { ...s.promotionFilters, ...f } })),
  createPromotion: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createPromotion(payload);
      await get().fetchPromotions();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to create promotion"), actionLoading: null });
    }
  },
  updatePromotion: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updatePromotion(id, payload);
      await get().fetchPromotions();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update promotion"), actionLoading: null });
    }
  },
  deletePromotion: async (id) => {
    set({ actionLoading: id });
    try {
      await deletePromotion(id);
      set((s) => ({ promotions: s.promotions.filter((p) => p.id !== id), actionLoading: null }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to delete promotion"), actionLoading: null });
    }
  },

  // ── Banners ────────────────────────────────────────────────────────────────
  fetchBanners: async () => {
    const { bannerFilters: f } = get();
    set({ isLoadingBanners: true, error: null });
    try {
      const res = await fetchBanners({ search: f.search || undefined, page: f.page, limit: f.limit });
      set({ banners: res.data, bannerPagination: buildPagination(res.meta), isLoadingBanners: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch banners"), isLoadingBanners: false });
    }
  },
  setBannerFilters: (f) => set((s) => ({ bannerFilters: { ...s.bannerFilters, ...f } })),
  fetchBannerDetail: async (id) => {
    set({ isLoadingBannerDetail: true, error: null });
    try {
      const detail = await fetchBannerById(id);
      set({ selectedBanner: detail, isLoadingBannerDetail: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch banner"), isLoadingBannerDetail: false });
    }
  },
  createBanner: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createBanner(payload);
      await get().fetchBanners();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to create banner"), actionLoading: null });
    }
  },
  updateBanner: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateBanner(id, payload);
      await get().fetchBanners();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update banner"), actionLoading: null });
    }
  },
  deleteBanner: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteBanner(id);
      set((s) => ({ banners: s.banners.filter((b) => b.id !== id), actionLoading: null }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to delete banner"), actionLoading: null });
    }
  },
  updateBannerStatus: async (id, status) => {
    set({ actionLoading: id });
    try {
      await updateBannerStatus(id, status);
      set((s) => ({
        banners: s.banners.map((b) => (b.id === id ? { ...b, status } : b)),
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to update banner status"), actionLoading: null });
    }
  },

  // ── Analytics ──────────────────────────────────────────────────────────────
  setAnalyticsDateRange: (range) => set({ analyticsDateRange: range }),
  fetchAnalyticsOverviewStats: async () => {
    const { analyticsDateRange } = get();
    set({ isLoadingAnalytics: true, error: null });
    try {
      const stats = await fetchAnalyticsOverviewStats(analyticsDateRange);
      set({ analyticsOverviewStats: stats, isLoadingAnalytics: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch overview stats"), isLoadingAnalytics: false });
    }
  },
  fetchAnalyticsSocialStats: async () => {
    const { analyticsDateRange } = get();
    set({ isLoadingAnalytics: true, error: null });
    try {
      const stats = await fetchAnalyticsSocialStats(analyticsDateRange);
      set({ analyticsSocialStats: stats, isLoadingAnalytics: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch social stats"), isLoadingAnalytics: false });
    }
  },
  fetchAnalyticsAdsPerformance: async () => {
    const { analyticsDateRange } = get();
    set({ isLoadingAnalytics: true, error: null });
    try {
      const perf = await fetchAnalyticsAdsPerformance(analyticsDateRange);
      set({ analyticsAdsPerformance: perf, isLoadingAnalytics: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch ads performance"), isLoadingAnalytics: false });
    }
  },
  fetchAnalyticsLocation: async () => {
    const { analyticsDateRange } = get();
    set({ isLoadingAnalytics: true, error: null });
    try {
      const res = await fetchAnalyticsLocation(analyticsDateRange);
      set({ analyticsLocation: res.data, isLoadingAnalytics: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch location analytics"), isLoadingAnalytics: false });
    }
  },
  fetchAnalyticsAudienceBreakdown: async () => {
    const { analyticsDateRange } = get();
    set({ isLoadingAnalytics: true, error: null });
    try {
      const breakdown = await fetchAnalyticsAudienceBreakdown(analyticsDateRange);
      set({ analyticsAudienceBreakdown: breakdown, isLoadingAnalytics: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch audience breakdown"), isLoadingAnalytics: false });
    }
  },
  fetchAnalyticsConversionFunnel: async () => {
    const { analyticsDateRange } = get();
    set({ isLoadingAnalytics: true, error: null });
    try {
      const funnel = await fetchAnalyticsConversionFunnel(analyticsDateRange);
      set({ analyticsConversionFunnel: funnel, isLoadingAnalytics: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch conversion funnel"), isLoadingAnalytics: false });
    }
  },
  fetchAnalyticsWeeklyEngagement: async () => {
    const { analyticsDateRange } = get();
    set({ isLoadingAnalytics: true, error: null });
    try {
      const engagement = await fetchAnalyticsWeeklyEngagement(analyticsDateRange);
      set({ analyticsWeeklyEngagement: engagement, isLoadingAnalytics: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch weekly engagement"), isLoadingAnalytics: false });
    }
  },
  fetchAnalyticsPerformanceData: async () => {
    const { analyticsDateRange } = get();
    set({ isLoadingAnalytics: true, error: null });
    try {
      const perf = await fetchAnalyticsPerformanceData(analyticsDateRange);
      set({ analyticsPerformanceData: perf, isLoadingAnalytics: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch performance data"), isLoadingAnalytics: false });
    }
  },
  fetchAnalyticsPlatformIntegrations: async () => {
    const { analyticsDateRange } = get();
    set({ isLoadingAnalytics: true, error: null });
    try {
      const res = await fetchAnalyticsPlatformIntegrations(analyticsDateRange);
      set({ analyticsPlatformIntegrations: res.data, isLoadingAnalytics: false });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch platform integrations"), isLoadingAnalytics: false });
    }
  },
  fetchAllAnalytics: async () => {
    set({ isLoadingAnalytics: true, error: null });
    const { analyticsDateRange } = get();
    try {
      const [
        overview, social, ads, location, audience, funnel, weekly, performance, integrations,
      ] = await Promise.all([
        fetchAnalyticsOverviewStats(analyticsDateRange),
        fetchAnalyticsSocialStats(analyticsDateRange),
        fetchAnalyticsAdsPerformance(analyticsDateRange),
        fetchAnalyticsLocation(analyticsDateRange),
        fetchAnalyticsAudienceBreakdown(analyticsDateRange),
        fetchAnalyticsConversionFunnel(analyticsDateRange),
        fetchAnalyticsWeeklyEngagement(analyticsDateRange),
        fetchAnalyticsPerformanceData(analyticsDateRange),
        fetchAnalyticsPlatformIntegrations(analyticsDateRange),
      ]);
      set({
        analyticsOverviewStats: overview,
        analyticsSocialStats: social,
        analyticsAdsPerformance: ads,
        analyticsLocation: location.data,
        analyticsAudienceBreakdown: audience,
        analyticsConversionFunnel: funnel,
        analyticsWeeklyEngagement: weekly,
        analyticsPerformanceData: performance,
        analyticsPlatformIntegrations: integrations.data,
        isLoadingAnalytics: false,
      });
    } catch (err: unknown) {
      set({ error: extractErrorMessage(err, "Failed to fetch analytics"), isLoadingAnalytics: false });
    }
  },

  clearError: () => set({ error: null }),
}));