import type {
  SOApprovalQueueItem,
  SOComment,
  SOConnection,
  SOContentItem,
  SOConversation,
  SOEscalation,
  SOIdentity,
  SOJob,
  SOMedia,
  SOPost,
  SOPublication,
  SOSettings,
} from "@/types/social-operations.types";

export const delay = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// ─── Connections & Identities (SO-02, SO-03) ──────────────────────────────────

export const mockSOConnections: SOConnection[] = [
  { id: "so-conn-fb-1", provider: "FACEBOOK", label: "CosmicForge Facebook Page", status: "ACTIVE", scopes: ["pages_manage_posts", "pages_read_engagement"], expiresAt: "2026-10-01T00:00:00.000Z", webhookHealthy: true, identityCount: 1, hasRequiredCredentials: true, createdAt: "2026-06-01T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" },
  { id: "so-conn-ig-1", provider: "INSTAGRAM", label: "CosmicForge Instagram", status: "ACTIVE", scopes: ["instagram_content_publish"], expiresAt: "2026-10-01T00:00:00.000Z", webhookHealthy: true, identityCount: 1, hasRequiredCredentials: true, createdAt: "2026-06-01T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" },
  { id: "so-conn-tiktok-1", provider: "TIKTOK", label: "CosmicForge TikTok", status: "REAUTHORIZATION_REQUIRED", scopes: ["video.publish"], expiresAt: "2026-07-24T00:00:00.000Z", webhookHealthy: false, identityCount: 1, hasRequiredCredentials: true, createdAt: "2026-06-05T09:00:00.000Z", updatedAt: "2026-07-24T09:00:00.000Z" },
  { id: "so-conn-x-1", provider: "X", label: "CosmicForge X", status: "PENDING_PLATFORM_APPROVAL", scopes: [], expiresAt: null, webhookHealthy: false, identityCount: 0, hasRequiredCredentials: false, createdAt: "2026-07-10T09:00:00.000Z", updatedAt: "2026-07-10T09:00:00.000Z" },
  { id: "so-conn-li-1", provider: "LINKEDIN", label: "CosmicForge LinkedIn Org", status: "ACTIVE", scopes: ["w_organization_social"], expiresAt: "2026-11-01T00:00:00.000Z", webhookHealthy: true, identityCount: 1, hasRequiredCredentials: true, createdAt: "2026-06-08T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" },
];

export const mockSOIdentities: SOIdentity[] = [
  { id: "so-id-fb-1", connectionId: "so-conn-fb-1", provider: "FACEBOOK", identityType: "FACEBOOK_PAGE", username: "CosmicForge Healthnet", avatarUrl: null, role: "PAGE_ADMIN", capabilities: { publishText: "AVAILABLE", publishImage: "AVAILABLE", publishVideo: "AVAILABLE", readComments: "AVAILABLE", replyComments: "AVAILABLE", readMessages: "AVAILABLE", sendMessages: "AVAILABLE", deletePost: "AVAILABLE" }, lastDiscoveryAt: "2026-07-20T09:00:00.000Z", status: "ACTIVE" },
  { id: "so-id-ig-1", connectionId: "so-conn-ig-1", provider: "INSTAGRAM", identityType: "INSTAGRAM_PROFESSIONAL", username: "cosmicforge.health", avatarUrl: null, role: "ADMIN", capabilities: { publishText: "AVAILABLE", publishImage: "AVAILABLE", publishVideo: "AVAILABLE", readComments: "AVAILABLE", replyComments: "AVAILABLE", readMessages: "REQUIRES_PLATFORM_APPROVAL", sendMessages: "REQUIRES_PLATFORM_APPROVAL", deletePost: "AVAILABLE" }, lastDiscoveryAt: "2026-07-20T09:00:00.000Z", status: "ACTIVE" },
  { id: "so-id-tiktok-1", connectionId: "so-conn-tiktok-1", provider: "TIKTOK", identityType: "TIKTOK_ACCOUNT", username: "cosmicforge", avatarUrl: null, role: "OWNER", capabilities: { publishText: "REQUIRES_REAUTHORIZATION", publishVideo: "REQUIRES_REAUTHORIZATION", readComments: "NATIVE_ONLY", sendMessages: "NATIVE_ONLY" }, lastDiscoveryAt: "2026-07-24T09:00:00.000Z", status: "REAUTHORIZATION_REQUIRED" },
  { id: "so-id-li-1", connectionId: "so-conn-li-1", provider: "LINKEDIN", identityType: "LINKEDIN_ORGANIZATION", username: "CosmicForge Healthnet", avatarUrl: null, role: "ADMIN", capabilities: { publishText: "AVAILABLE", publishImage: "AVAILABLE", publishVideo: "AVAILABLE", readComments: "AVAILABLE", replyComments: "AVAILABLE", sendMessages: "NATIVE_ONLY" }, lastDiscoveryAt: "2026-07-20T09:00:00.000Z", status: "ACTIVE" },
];

// ─── Posts / Composer / Approvals (SO-04..06) ─────────────────────────────────

export const mockSOPosts: SOPost[] = [
  { id: "so-post-1", title: "World Health Day Awareness", baseText: "Celebrating better access to care.", campaign: "Awareness Q3", status: "PENDING_APPROVAL", targets: [{ identityId: "so-id-fb-1", provider: "FACEBOOK", text: "Celebrating better access to care. #WorldHealthDay", mediaIds: ["so-media-1"] }, { identityId: "so-id-ig-1", provider: "INSTAGRAM", text: "Better access to care starts here 💙", mediaIds: ["so-media-1"] }], version: 2, createdBy: "Idowu", createdAt: "2026-07-23T10:00:00.000Z", updatedAt: "2026-07-24T09:00:00.000Z", scheduledFor: null },
  { id: "so-post-2", title: "New Telemedicine Feature", baseText: "Book a consult in under 2 minutes.", campaign: "Product Launch", status: "APPROVED", targets: [{ identityId: "so-id-li-1", provider: "LINKEDIN", text: "Book a consult in under 2 minutes with our new telemedicine flow.", mediaIds: [] }], version: 1, createdBy: "Idowu", createdAt: "2026-07-20T10:00:00.000Z", updatedAt: "2026-07-21T09:00:00.000Z", scheduledFor: "2026-07-27T09:00:00.000Z" },
  { id: "so-post-3", title: "Draft — Pharmacy Partner Spotlight", baseText: "Spotlight on our pharmacy partners.", campaign: null, status: "DRAFT", targets: [{ identityId: "so-id-fb-1", provider: "FACEBOOK", text: "Spotlight on our pharmacy partners.", mediaIds: [] }], version: 1, createdBy: "Idowu", createdAt: "2026-07-24T14:00:00.000Z", updatedAt: "2026-07-24T14:00:00.000Z", scheduledFor: null },
  { id: "so-post-4", title: "Doctor Onboarding Recap", baseText: "Welcoming 12 new specialists this month.", campaign: "Awareness Q3", status: "PARTIALLY_PUBLISHED", targets: [{ identityId: "so-id-fb-1", provider: "FACEBOOK", text: "Welcoming 12 new specialists this month!", mediaIds: [] }, { identityId: "so-id-tiktok-1", provider: "TIKTOK", text: "Welcoming 12 new specialists 🎉", mediaIds: ["so-media-2"] }], version: 1, createdBy: "Idowu", createdAt: "2026-07-18T10:00:00.000Z", updatedAt: "2026-07-19T09:00:00.000Z", scheduledFor: null },
];

export const mockSOMedia: SOMedia[] = [
  { id: "so-media-1", fileName: "world-health-day.jpg", mimeType: "image/jpeg", sizeBytes: 842000, width: 1200, height: 1200, durationSeconds: null, aspectRatio: "1:1", checksum: "a1b2c3", status: "READY", ownerId: "Idowu", usageCount: 2, thumbnailUrl: null, createdAt: "2026-07-22T10:00:00.000Z" },
  { id: "so-media-2", fileName: "doctor-onboarding.mp4", mimeType: "video/mp4", sizeBytes: 15400000, width: 1080, height: 1920, durationSeconds: 24, aspectRatio: "9:16", checksum: "d4e5f6", status: "READY", ownerId: "Idowu", usageCount: 1, thumbnailUrl: null, createdAt: "2026-07-18T08:00:00.000Z" },
  { id: "so-media-3", fileName: "pharmacy-spotlight.png", mimeType: "image/png", sizeBytes: 512000, width: 1080, height: 1080, durationSeconds: null, aspectRatio: "1:1", checksum: "g7h8i9", status: "PROCESSING", ownerId: "Idowu", usageCount: 0, thumbnailUrl: null, createdAt: "2026-07-24T14:05:00.000Z" },
];

export const mockSOApprovalQueue: SOApprovalQueueItem[] = [
  { postId: "so-post-1", postTitle: "World Health Day Awareness", version: 2, submittedBy: "Idowu", submittedAt: "2026-07-24T09:00:00.000Z", targetIdentities: ["so-id-fb-1", "so-id-ig-1"], ageHours: 26 },
];

// ─── Publications & Content library (SO-07..09) ────────────────────────────────

export const mockSOPublications: SOPublication[] = [
{ id: "so-pub-1", postId: "so-post-4", postTitle: "Doctor Onboarding Recap", status: "AWAITING_USER_ACTION", targets: [
      { identityId: "so-id-fb-1", identityLabel: "CosmicForge Healthnet (FB)", provider: "FACEBOOK", status: "PUBLISHED", providerPostId: "fb-9182", providerUrl: "https://facebook.com/example/posts/9182" },
      { identityId: "so-id-tiktok-1", identityLabel: "cosmicforge (TikTok)", provider: "TIKTOK", status: "AWAITING_USER_ACTION", postingMode: "UPLOAD_TO_DRAFT" },
    ], attempts: 1, scheduledFor: null, createdAt: "2026-07-19T09:00:00.000Z", updatedAt: "2026-07-19T09:05:00.000Z" },
  { id: "so-pub-2", postId: "so-post-2", postTitle: "New Telemedicine Feature", status: "PENDING", targets: [
      { identityId: "so-id-li-1", identityLabel: "CosmicForge Healthnet (LinkedIn)", provider: "LINKEDIN", status: "PENDING" },
    ], attempts: 0, scheduledFor: "2026-07-27T09:00:00.000Z", createdAt: "2026-07-21T09:00:00.000Z", updatedAt: "2026-07-21T09:00:00.000Z" },
];

export const mockSOContentItems: SOContentItem[] = [
  { id: "so-content-1", source: "ADMIN_PUBLISHED", provider: "FACEBOOK", identityId: "so-id-fb-1", identityLabel: "CosmicForge Healthnet (FB)", type: "IMAGE", text: "Welcoming 12 new specialists this month!", providerUrl: "https://facebook.com/example/posts/9182", publishedAt: "2026-07-19T09:05:00.000Z", metrics: { impressions: 8200, reach: 6100, likes: 340, comments: 22, shares: 14 }, commentCount: 22 },
  { id: "so-content-2", source: "PROVIDER_IMPORTED", provider: "INSTAGRAM", identityId: "so-id-ig-1", identityLabel: "cosmicforge.health (IG)", type: "REEL", text: "Behind the scenes at our new clinic.", providerUrl: "https://instagram.com/p/example", publishedAt: "2026-07-15T09:00:00.000Z", metrics: { impressions: 15400, reach: 12000, likes: 980, comments: 61, videoViews: 9800 }, commentCount: 61 },
];

// ─── Inbox & Comments (SO-10, SO-11) ──────────────────────────────────────────

export const mockSOConversations: SOConversation[] = [
  { id: "so-conv-1", provider: "FACEBOOK", identityId: "so-id-fb-1", contactName: "Adaeze O.", unreadCount: 2, lastMessageAt: "2026-07-25T08:10:00.000Z", lastMessagePreview: "How do I book a follow-up appointment?", owner: null, priority: "MEDIUM", status: "OPEN", restricted: false },
  { id: "so-conv-2", provider: "INSTAGRAM", identityId: "so-id-ig-1", contactName: "chuka.d", unreadCount: 0, lastMessageAt: "2026-07-24T18:40:00.000Z", lastMessagePreview: "Thanks for the quick response!", owner: "Idowu", priority: "LOW", status: "RESOLVED", restricted: false },
  { id: "so-conv-3", provider: "FACEBOOK", identityId: "so-id-fb-1", contactName: "Hidden — restricted", unreadCount: 1, lastMessageAt: "2026-07-25T07:00:00.000Z", lastMessagePreview: "Content hidden — restricted visibility", owner: null, priority: "HIGH", status: "OPEN", restricted: true },
];

export const mockSOComments: SOComment[] = [
  { id: "so-comment-1", contentId: "so-content-1", provider: "FACEBOOK", author: "Bimpe A.", text: "Congrats on the new specialists!", direction: "INBOUND", parentId: null, status: "VISIBLE", createdAt: "2026-07-19T10:00:00.000Z" },
  { id: "so-comment-2", contentId: "so-content-2", provider: "INSTAGRAM", author: "user_2291", text: "Is this location open on weekends?", direction: "INBOUND", parentId: null, status: "VISIBLE", createdAt: "2026-07-15T11:00:00.000Z" },
];

// ─── Escalations (SO-12) ───────────────────────────────────────────────────────

export const mockSOEscalations: SOEscalation[] = [
  { id: "so-esc-1", classification: "CLINICAL_ADVICE_REQUEST", status: "CONFIRMED", sourceType: "COMMENT", sourceId: "so-comment-2", assignee: null, taskId: null, detectedAt: "2026-07-15T11:05:00.000Z", restrictedVisibility: true },
];

// ─── Operations jobs (SO-14) ───────────────────────────────────────────────────

export const mockSOJobs: SOJob[] = [
  { id: "so-job-1", type: "PUBLISHING", provider: "TIKTOK", identityId: "so-id-tiktok-1", status: "RETRY_SCHEDULED", attempts: 2, nextAttemptAt: "2026-07-25T12:00:00.000Z", error: "REAUTHORIZATION_REQUIRED", relatedPostId: "so-post-4", createdAt: "2026-07-19T09:05:00.000Z", updatedAt: "2026-07-24T09:00:00.000Z" },
  { id: "so-job-2", type: "PUBLISHING", provider: "LINKEDIN", identityId: "so-id-li-1", status: "PENDING", attempts: 0, nextAttemptAt: null, error: null, relatedPostId: "so-post-2", createdAt: "2026-07-21T09:00:00.000Z", updatedAt: "2026-07-21T09:00:00.000Z" },
];

// ─── Settings (SO-15) ──────────────────────────────────────────────────────────

export const mockSOSettings: SOSettings = {
  approvalSelfReviewAllowed: false,
  defaultTimezone: "Africa/Lagos",
  retryLimit: 3,
  slaFirstResponseMinutes: 60,
  slaResolutionMinutes: 1440,
  retentionDays: 365,
};