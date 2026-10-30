import api from "./api";
import type {
  SOApiEnvelope,
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
import {
  delay,
  mockSOConnections,
  mockSOIdentities,
  mockSOPosts,
  mockSOMedia,
  mockSOApprovalQueue,
  mockSOPublications,
  mockSOContentItems,
  mockSOConversations,
  mockSOComments,
  mockSOEscalations,
  mockSOJobs,
  mockSOSettings,
} from "./social-operations.mock";

const USE_MOCK = true;
const BASE = "/api/v1/marketing/social";

// ─── Connections & Identities (SO-02, SO-03) ──────────────────────────────────

export const fetchSOConnections = async (): Promise<SOConnection[]> => {
  if (USE_MOCK) { await delay(); return mockSOConnections; }
  const { data } = await api.get<SOApiEnvelope<SOConnection[]>>(`${BASE}/connections`);
  return data.data;
};

export const testSOConnection = async (id: string): Promise<{ status: "SUCCESS" | "FAILED" }> => {
  if (USE_MOCK) { await delay(800); return { status: "SUCCESS" }; }
  const { data } = await api.post<SOApiEnvelope<{ status: "SUCCESS" | "FAILED" }>>(`${BASE}/connections/${id}/test`);
  return data.data;
};

export const reauthorizeSOConnection = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/connections/${id}/reauthorize`);
};

export const disableSOConnection = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/connections/${id}/disable`);
};

export const enableSOConnection = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/connections/${id}/enable`);
};

export const discoverSOIdentities = async (connectionId: string): Promise<SOIdentity[]> => {
  if (USE_MOCK) { await delay(1000); return mockSOIdentities.filter((i) => i.connectionId === connectionId); }
  const { data } = await api.post<SOApiEnvelope<SOIdentity[]>>(`${BASE}/connections/${connectionId}/discover-identities`);
  return data.data;
};

export const fetchSOIdentities = async (): Promise<SOIdentity[]> => {
  if (USE_MOCK) { await delay(); return mockSOIdentities; }
  const { data } = await api.get<SOApiEnvelope<SOIdentity[]>>(`${BASE}/identities`);
  return data.data;
};

export const refreshSOIdentityCapabilities = async (id: string): Promise<SOIdentity> => {
  if (USE_MOCK) {
    await delay(700);
    const identity = mockSOIdentities.find((i) => i.id === id);
    if (!identity) throw new Error("Identity not found");
    return identity;
  }
  const { data } = await api.post<SOApiEnvelope<SOIdentity>>(`${BASE}/identities/${id}/refresh-capabilities`);
  return data.data;
};

// ─── Content, composer, approvals (SO-04..06) ─────────────────────────────────

export const fetchSOPosts = async (): Promise<SOPost[]> => {
  if (USE_MOCK) { await delay(); return mockSOPosts; }
  const { data } = await api.get<SOApiEnvelope<SOPost[]>>(`${BASE}/posts`);
  return data.data;
};

export const fetchSOPost = async (id: string): Promise<SOPost> => {
  if (USE_MOCK) {
    await delay();
    const post = mockSOPosts.find((p) => p.id === id);
    if (!post) throw new Error("Post not found");
    return post;
  }
  const { data } = await api.get<SOApiEnvelope<SOPost>>(`${BASE}/posts/${id}`);
  return data.data;
};

export const createSOPost = async (payload: Partial<SOPost>): Promise<SOPost> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockSOPosts[2], id: "so-post-new-" + Date.now(), ...payload, status: "DRAFT" } as SOPost;
  }
  const { data } = await api.post<SOApiEnvelope<SOPost>>(`${BASE}/posts`, payload);
  return data.data;
};

export const updateSOPost = async (id: string, payload: Partial<SOPost>): Promise<SOPost> => {
  if (USE_MOCK) {
    await delay();
    const post = mockSOPosts.find((p) => p.id === id);
    if (!post) throw new Error("Post not found");
    return { ...post, ...payload };
  }
  const { data } = await api.patch<SOApiEnvelope<SOPost>>(`${BASE}/posts/${id}`, payload);
  return data.data;
};

export const submitSOPostForReview = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/posts/${id}/submit`);
};

export const approveSOPost = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/posts/${id}/approve`);
};

export const rejectSOPost = async (id: string, reason: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/posts/${id}/reject`, { reason });
};

export const requestSOPostChanges = async (id: string, reason: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/posts/${id}/request-changes`, { reason });
};

export const fetchSOApprovalQueue = async (): Promise<SOApprovalQueueItem[]> => {
  if (USE_MOCK) { await delay(); return mockSOApprovalQueue; }
  const { data } = await api.get<SOApiEnvelope<SOApprovalQueueItem[]>>(`${BASE}/posts`, { params: { status: "PENDING_APPROVAL" } });
  return data.data;
};

export const fetchSOMedia = async (): Promise<SOMedia[]> => {
  if (USE_MOCK) { await delay(); return mockSOMedia; }
  const { data } = await api.get<SOApiEnvelope<SOMedia[]>>(`${BASE}/media`);
  return data.data;
};

export const deleteSOMedia = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.delete(`${BASE}/media/${id}`);
};

// ─── Publishing & calendar (SO-07, SO-08) ─────────────────────────────────────

export const fetchSOPublications = async (): Promise<SOPublication[]> => {
  if (USE_MOCK) { await delay(); return mockSOPublications; }
  const { data } = await api.get<SOApiEnvelope<SOPublication[]>>(`${BASE}/publications`);
  return data.data;
};

export const publishSOPostNow = async (postId: string): Promise<void> => {
  if (USE_MOCK) { await delay(1200); return; }
  await api.post(`${BASE}/posts/${postId}/publish`);
};

export const scheduleSOPost = async (postId: string, scheduledFor: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/posts/${postId}/schedule`, { scheduledFor });
};

export const retrySOPublication = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(1000); return; }
  await api.post(`${BASE}/publications/${id}/retry`);
};

export const cancelSOPublication = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/publications/${id}/cancel`);
};

// ─── Provider content library (SO-09) ─────────────────────────────────────────

export const fetchSOContentItems = async (): Promise<SOContentItem[]> => {
  if (USE_MOCK) { await delay(); return mockSOContentItems; }
  const { data } = await api.get<SOApiEnvelope<SOContentItem[]>>(`${BASE}/content`);
  return data.data;
};

export const syncSOIdentityContent = async (identityId: string): Promise<void> => {
  if (USE_MOCK) { await delay(1200); return; }
  await api.post(`${BASE}/identities/${identityId}/sync-content`);
};

// ─── Inbox & moderation (SO-10, SO-11) ─────────────────────────────────────────

export const fetchSOConversations = async (): Promise<SOConversation[]> => {
  if (USE_MOCK) { await delay(); return mockSOConversations; }
  const { data } = await api.get<SOApiEnvelope<SOConversation[]>>(`${BASE}/conversations`);
  return data.data;
};

export const replySOConversation = async (id: string, text: string): Promise<void> => {
  if (USE_MOCK) { await delay(700); return; }
  await api.post(`${BASE}/conversations/${id}/reply`, { text });
};

export const resolveSOConversation = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/conversations/${id}/resolve`);
};

export const fetchSOComments = async (): Promise<SOComment[]> => {
  if (USE_MOCK) { await delay(); return mockSOComments; }
  const { data } = await api.get<SOApiEnvelope<SOComment[]>>(`${BASE}/comments`);
  return data.data;
};

export const hideSOComment = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/comments/${id}/hide`);
};

export const escalateSOComment = async (id: string, classification: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/comments/${id}/escalate`, { classification });
};

// ─── Escalations (SO-12) ───────────────────────────────────────────────────────

export const fetchSOEscalations = async (): Promise<SOEscalation[]> => {
  if (USE_MOCK) { await delay(); return mockSOEscalations; }
  const { data } = await api.get<SOApiEnvelope<SOEscalation[]>>(`${BASE}/escalations`);
  return data.data;
};

// ─── Operations monitor (SO-14) ────────────────────────────────────────────────

export const fetchSOJobs = async (): Promise<SOJob[]> => {
  if (USE_MOCK) { await delay(); return mockSOJobs; }
  const { data } = await api.get<SOApiEnvelope<SOJob[]>>(`${BASE}/operations`);
  return data.data;
};

export const retrySOJob = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(800); return; }
  await api.post(`${BASE}/operations/${id}/retry`);
};

export const cancelSOJob = async (id: string): Promise<void> => {
  if (USE_MOCK) { await delay(); return; }
  await api.post(`${BASE}/operations/${id}/cancel`);
};

// ─── Settings (SO-15) ──────────────────────────────────────────────────────────

export const fetchSOSettings = async (): Promise<SOSettings> => {
  if (USE_MOCK) { await delay(); return mockSOSettings; }
  const { data } = await api.get<SOApiEnvelope<SOSettings>>(`${BASE}/settings`);
  return data.data;
};

export const updateSOSettings = async (payload: Partial<SOSettings>): Promise<SOSettings> => {
  if (USE_MOCK) { await delay(); return { ...mockSOSettings, ...payload }; }
  const { data } = await api.patch<SOApiEnvelope<SOSettings>>(`${BASE}/settings`, payload);
  return data.data;
};