// ─── Enums ───────────────────────────────────────────────────────────────────

export type CampaignType = "Email" | "Social" | "Events" | "Ads";
export type CampaignStatus = "Active" | "Drafts" | "Completed" | "Paused" | "Archived";
export type CampaignListStatus = "Active" | "Drafts" | "Completed" | "Paused";
export type ContentStatus = "Published" | "Draft";
export type SocialPlatform = "Facebook" | "Instagram" | "Youtube" | "Twitter" | "Tiktok" | "LinkedIn";
export type SocialPostListPlatform = "All" | SocialPlatform;
export type SocialPostStatus = "Published" | "Scheduled" | "Draft" | "Deleted";
export type EmailRecipient = "Customer" | "Recipients" | "Admin";
export type PromotionTab = "All" | "Active Promotions" | "Upcoming Promotions" | "Ended Promotions";
export type PromotionStatus = "Upcoming" | "Active" | "Completed" | "Ended";
export type BannerStatus = "Active" | "Inactive" | "Expired";

// ─── Shared ──────────────────────────────────────────────────────────────────

export interface MarketingPagination {
  currentPage: number;
  totalPages: number;
  totalItems: number;
}

// Backend already returns totalPages pre-computed (unlike admin-ops' raw total/page/limit)
export interface MarketingMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface MetricPoint {
  label: string;
  value: string;
}

export interface KpiValue {
  value: number | string;
  change: string;
  up: boolean;
}

export interface KpiValueWithToday extends KpiValue {
  today: number;
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

export interface CampaignListItem {
  id: string;
  title: string;
  type: CampaignType;
  status: CampaignStatus;
  date: string | null;
  progress: number;
  metrics: MetricPoint[];
}

export interface CampaignStats {
  total: number;
  active: number;
  drafts: number;
  completed: number;
}

export interface CampaignListResponse {
  data: CampaignListItem[];
  stats: CampaignStats;
  meta: MarketingMeta;
}

export interface CampaignDetail {
  id: string;
  title: string;
  type: CampaignType;
  status: CampaignStatus;
  budget: number | null;
  progress: number;
  startedAt: string | null;
  estCompletion: string | null;
  targetAudience: string | null;
  duration: string | null;
  channels: string[];
  overview: string | null;
  stats: {
    totalReach: string;
    engagementRate: string;
    conversionRate: string;
    costPerClick: string;
  };
}

export interface CampaignMutationResult {
  id: string;
  title: string;
  type: CampaignType;
  status: CampaignStatus;
  description: string | null;
  budget: number | null;
  progress: number;
  launchDate: string | null;
  estCompletion: string | null;
  targetAudience: string | null;
  duration: string | null;
  channels: string[];
  overview: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CampaignPerformance {
  opens: string;
  clicks: string;
  conversions: string;
}

export interface CampaignTimelineItem {
  label: string;
  date: string | null;
  done: boolean;
}

export interface CampaignTeamMember {
  id: string;
  name: string;
  role: string;
}

export interface CreateCampaignPayload {
  title: string;
  type: CampaignType;
  description?: string;
  launchDate: string;
}

export interface UpdateCampaignPayload {
  title?: string;
  type?: CampaignType;
  description?: string;
  budget?: number;
  launchDate?: string;
  estCompletion?: string;
  targetAudience?: string;
  duration?: string;
  channels?: string[];
  overview?: string;
}

export interface CampaignListQuery {
  page?: number;
  limit?: number;
  status?: CampaignListStatus;
  type?: CampaignType;
  search?: string;
}

export interface CampaignFilters {
  search: string;
  status: CampaignListStatus | "";
  type: CampaignType | "";
  page: number;
  limit: number;
}

// ─── Content Manager ─────────────────────────────────────────────────────────

export interface ContentListItem {
  id: string;
  title: string;
  type: string;
  author: string;
  status: ContentStatus;
  updatedAt: string | null;
  performance: number;
}

export interface ContentCounts {
  sent: number;
  draft: number;
}

export interface ContentListResponse {
  data: ContentListItem[];
  counts: ContentCounts;
  meta: MarketingMeta;
}

export interface ContentDetail {
  id: string;
  title: string;
  type: string;
  author: string;
  link: string | null;
  description: string | null;
  status: ContentStatus;
}

export interface ContentMutationResult {
  id: string;
  title: string;
  type: string;
  authorId: string;
  author: string;
  link: string | null;
  description: string | null;
  status: ContentStatus;
  performance: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ContentPerformancePoint {
  month: string;
  value: number;
}

export interface ContentPerformance {
  chartData: ContentPerformancePoint[];
}

export interface CreateContentPayload {
  title: string;
  type: string;
  authorId: string;
  link?: string;
  description?: string;
}

export interface UpdateContentPayload {
  title?: string;
  type?: string;
  authorId?: string;
  link?: string;
  description?: string;
  status?: ContentStatus;
  performance?: number;
}

export interface ContentListQuery {
  page?: number;
  limit?: number;
  status?: ContentStatus;
  search?: string;
}

export interface ContentFilters {
  search: string;
  status: ContentStatus | "";
  page: number;
  limit: number;
}

export interface ContentReportQuery {
  format?: "csv" | "pdf";
}

export interface ContentReportResult {
  filename: string;
  blob: Blob;
}

// ─── Email Templates ─────────────────────────────────────────────────────────

export interface MessageContentBlock {
  greeting: string;
  vars: string[];
  body: string;
  trackingVar: string;
}

export interface ConditionalBlock {
  condition: string;
  message: string;
}

export interface EmailTemplateListItem {
  id: string;
  eventCode: string;
  event: string;
  customerChannels: string[];
  recipientChannels: string[];
  validToDate: string | null;
}

export interface EmailTemplateListResponse {
  data: EmailTemplateListItem[];
  meta: MarketingMeta;
}

export interface EmailTemplateVersion {
  id: string;
  validFrom: string | null;
  validTo: string | null;
  language: string;
  status: string;
}

export interface EmailTemplateDetail {
  id: string;
  eventCode: string;
  notifyEnabled: boolean;
  channels: {
    email: boolean;
    whatsapp: boolean;
    sms: boolean;
  };
  recipients: EmailRecipient[];
  templates: EmailTemplateVersion[];
  customer: {
    fullName: string;
    email: string;
    phone: string;
    country: string;
  };
  emailContent: MessageContentBlock;
  conditionalBlock: ConditionalBlock;
  whatsappContent: MessageContentBlock;
}

export interface EmailTemplateCreateResult {
  id: string;
  eventCode: string;
}

export interface CreateEmailTemplatePayload {
  event: string;
  validFrom: string;
  validTo: string;
  language: string;
}

export interface UpdateEmailTemplatePayload {
  validFrom?: string;
  validTo?: string;
  language?: string;
}

export interface EmailTemplateRecipientsPayload {
  channels: { email: boolean; whatsapp: boolean; sms: boolean };
  recipients: EmailRecipient[];
}

export interface EmailTemplateContentPayload {
  emailContent?: Partial<MessageContentBlock>;
  conditionalBlock?: Partial<ConditionalBlock>;
  whatsappContent?: Partial<MessageContentBlock>;
}

export interface EmailTemplateListQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export interface EmailTemplateFilters {
  search: string;
  page: number;
  limit: number;
}

export interface EmailTemplateCustomerSearchResult {
  data: unknown[];
}

// ─── Social Media ────────────────────────────────────────────────────────────

export interface SocialAccount {
  id: string;
  platform: SocialPlatform;
  username: string;
  connected: boolean;
}

export interface SocialLocationStat {
  country: string;
  value: number;
  change: string;
  up: boolean;
}

export interface SocialAudienceBreakdownItem {
  platform: string;
  value: number;
  color?: string;
  change: string;
  up: boolean;
}

export interface SocialAudienceOverview {
  total: number;
  change: string;
  breakdown: SocialAudienceBreakdownItem[];
}

export interface SocialWeeklyEngagementPoint {
  day: string;
  value: number;
}

export interface SocialRecentUpload {
  id: string | null;
  title: string;
  excerpt: string;
  likesCount: number;
}

export interface SocialOverview {
  stats: {
    userEngagement: number;
    trafficSources: number;
    audienceGrowth: number;
    contentPerformance: number;
  };
  locations: SocialLocationStat[];
  audience: SocialAudienceOverview;
  recentUpload: SocialRecentUpload;
  weeklyEngagement: SocialWeeklyEngagementPoint[];
  totalEngagementChange: string;
}

export interface SocialPostListItem {
  id: string;
  platform: SocialPlatform;
  thumbnailUrl: string | null;
  postedAt: string | null;
  excerpt: string;
  followers: string;
  views: string;
  totalLikes: string;
  comments: string;
}

export interface SocialPostLocation {
  country?: string;
  value?: number;
  [key: string]: unknown;
}

export interface SocialPostDetail {
  id: string;
  platform: SocialPlatform;
  imageUrl: string | null;
  postedAt: string | null;
  description: string;
  followers: string;
  views: string;
  totalLikes: string;
  comments: string;
  locations: SocialPostLocation[];
  performance: {
    totalViews: number;
    change: string;
    likes: number;
    reposts: number;
    comments: number;
  };
}

export interface CreateSocialAccountPayload {
  platform: SocialPlatform;
  username: string;
  password: string;
  saveCredentials?: boolean;
}

export interface SocialPostsListQuery {
  platform?: SocialPostListPlatform;
  page?: number;
  limit?: number;
}

export interface SocialPostFilters {
  platform: SocialPostListPlatform;
  page: number;
  limit: number;
}

export interface CreateSocialPostPayload {
  platform: SocialPlatform;
  caption: string;
  attachmentUrl?: string;
}

export interface UpdateSocialPostPayload {
  caption?: string;
  attachmentUrl?: string;
  attachmentUrls?: string[];
}

export interface SocialScheduleQuery {
  month?: string;
  weekStart?: string;
}

export interface SocialScheduleDay {
  day: string;
  date: number;
}

export interface SocialScheduleSlotPost {
  platform: SocialPlatform;
  text: string;
  images: string[];
  extra: number;
}

export interface SocialScheduleSlot {
  time: string;
  posts: SocialScheduleSlotPost[];
}

export interface SocialSchedule {
  days: SocialScheduleDay[];
  slots: SocialScheduleSlot[];
}

export interface CreateSocialSchedulePayload {
  platform: SocialPlatform;
  caption: string;
  attachmentUrls?: string[];
  scheduledFor: string;
}

export interface SocialInsightsQuery {
  from?: string;
  to?: string;
}

export interface SocialInsightItem {
  platform: SocialPlatform;
  posts: number;
  audience: string;
  totalLikes: string;
  followers: string;
}

// ─── Promotions ──────────────────────────────────────────────────────────────

export interface PromotionListItem {
  id: string;
  title: string;
  discountType: string;
  startDate: string | null;
  endDate: string | null;
  grossSales: string;
  averageRate: string;
  grossRevenue: string;
  status: PromotionStatus;
}

export interface PromotionStats {
  totalPromotions: number;
  engagementRate: string;
  revenue: string;
}

export interface PromotionListResponse {
  data: PromotionListItem[];
  stats: PromotionStats;
  meta: MarketingMeta;
}

export interface PromotionMutationResult {
  id: string;
  title: string;
  discountType: string;
  startDate: string | null;
  endDate: string | null;
  grossSales: number;
  averageRate: number;
  grossRevenue: number;
  status: PromotionStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreatePromotionPayload {
  title: string;
  discountType: string;
  startDate: string;
  endDate: string;
}

export interface UpdatePromotionPayload {
  title?: string;
  discountType?: string;
  startDate?: string;
  endDate?: string;
  grossSales?: number;
  averageRate?: number;
  grossRevenue?: number;
  status?: PromotionStatus;
}

export interface PromotionListQuery {
  page?: number;
  limit?: number;
  tab?: PromotionTab;
  search?: string;
}

export interface PromotionFilters {
  search: string;
  tab: PromotionTab;
  page: number;
  limit: number;
}

// ─── Banners ─────────────────────────────────────────────────────────────────

export interface BannerListItem {
  id: string;
  mediaType: string;
  title: string;
  description: string;
  display: string;
  externalLink: string;
  status: BannerStatus;
}

export interface BannerListResponse {
  data: BannerListItem[];
  meta: MarketingMeta;
}

export interface BannerDetail {
  id: string;
  imageUrl: string | null;
  title: string;
  description: string;
  display: string;
  placement: string;
  externalLink: string;
  startDate: string | null;
  endDate: string | null;
  status: BannerStatus;
  performance: {
    totalImpressions: string;
    change: string;
    clicks: string;
    clicksChange: string;
    signup: string;
    signupChange: string;
  };
}

export interface BannerMutationResult {
  id: string;
  mediaType: string;
  fileName: string | null;
  fileUrl: string | null;
  imageUrl: string | null;
  title: string;
  description: string;
  display: string[];
  placement: string[];
  externalLink: string;
  startDate: string | null;
  endDate: string | null;
  status: BannerStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreateBannerPayload {
  title: string;
  description: string;
  display: string | string[];
  placement: string | string[];
  externalLink: string;
  startDate: string;
  endDate: string;
  file: File;
}

export interface UpdateBannerPayload {
  title?: string;
  description?: string;
  display?: string | string[];
  placement?: string | string[];
  externalLink?: string;
  startDate?: string;
  endDate?: string;
  totalImpressions?: number;
  impressionsChange?: number;
  clicks?: number;
  clicksChange?: number;
  signup?: number;
  signupChange?: number;
  file?: File;
}

export interface BannerListQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export interface BannerFilters {
  search: string;
  page: number;
  limit: number;
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface AnalyticsDateRangeQuery {
  from?: string;
  to?: string;
}

export interface AnalyticsOverviewStats {
  leadsCapture: KpiValue;
  campaignRoi: KpiValue;
  clickThroughRate: KpiValue;
  costPerClick: KpiValue;
  impressions: KpiValue;
}

export interface AnalyticsSocialStats {
  userEngagement: KpiValueWithToday;
  trafficSources: KpiValueWithToday;
  audienceGrowth: KpiValueWithToday;
  contentPerformance: KpiValueWithToday;
}

export interface AnalyticsAdsPerformance {
  byPlatform: unknown[];
  monthlyTrend: unknown[];
}

export interface AnalyticsLocationItem {
  country: string;
  flag: string;
  value: number;
  change: string;
  up: boolean;
}

export interface AnalyticsLocationResponse {
  data: AnalyticsLocationItem[];
}

export interface AnalyticsAudienceBreakdown {
  total: number;
  change: string;
  breakdown: SocialAudienceBreakdownItem[];
}

export interface AnalyticsConversionFunnel {
  leads: { users: number; percent: number };
  nurture: { users: number; percent: number };
  conversion: { users: number; percent: number };
}

export interface AnalyticsWeeklyEngagement {
  data: SocialWeeklyEngagementPoint[];
  change: string;
}

export interface AnalyticsPerformanceData {
  totalViews: number;
  change: string;
  likes: KpiValue;
  reposts: KpiValue;
  comments: KpiValue;
}

export interface AnalyticsPlatformIntegration {
  platform: string;
  connected: boolean;
}

export interface AnalyticsPlatformIntegrationsResponse {
  data: AnalyticsPlatformIntegration[];
}