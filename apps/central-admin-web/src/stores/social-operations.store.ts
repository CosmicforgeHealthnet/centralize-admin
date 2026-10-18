import { create } from "zustand";
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
import {
  fetchSOConnections, testSOConnection, reauthorizeSOConnection, disableSOConnection, enableSOConnection,
  discoverSOIdentities, fetchSOIdentities, refreshSOIdentityCapabilities,
  fetchSOPosts, fetchSOPost, createSOPost, updateSOPost, submitSOPostForReview,
  approveSOPost, rejectSOPost, requestSOPostChanges, fetchSOApprovalQueue,
  fetchSOMedia, deleteSOMedia,
  fetchSOPublications, publishSOPostNow, scheduleSOPost, retrySOPublication, cancelSOPublication,
  fetchSOContentItems, syncSOIdentityContent,
  fetchSOConversations, replySOConversation, resolveSOConversation,
  fetchSOComments, hideSOComment, escalateSOComment,
  fetchSOEscalations,
  fetchSOJobs, retrySOJob, cancelSOJob,
  fetchSOSettings, updateSOSettings,
} from "@/lib/social-operations.service";
import { readHttpErrorMessage } from "@/lib/error-messages";


interface SocialOperationsState {
  // ── Connections & identities ─────────────────────────────────────────────
  connections: SOConnection[];
  isLoadingConnections: boolean;
  identities: SOIdentity[];
  isLoadingIdentities: boolean;

  // ── Content, composer, approvals ─────────────────────────────────────────
  posts: SOPost[];
  isLoadingPosts: boolean;
  selectedPost: SOPost | null;
  isLoadingPostDetail: boolean;
  approvalQueue: SOApprovalQueueItem[];
  isLoadingApprovalQueue: boolean;
  media: SOMedia[];
  isLoadingMedia: boolean;

  // ── Publishing & calendar ────────────────────────────────────────────────
  publications: SOPublication[];
  isLoadingPublications: boolean;

  // ── Provider content library ─────────────────────────────────────────────
  contentItems: SOContentItem[];
  isLoadingContentItems: boolean;

  // ── Inbox & moderation ────────────────────────────────────────────────────
  conversations: SOConversation[];
  isLoadingConversations: boolean;
  comments: SOComment[];
  isLoadingComments: boolean;
  escalations: SOEscalation[];
  isLoadingEscalations: boolean;

  // ── Operations monitor ────────────────────────────────────────────────────
  jobs: SOJob[];
  isLoadingJobs: boolean;

  // ── Settings ──────────────────────────────────────────────────────────────
  settings: SOSettings | null;
  isLoadingSettings: boolean;

  actionLoading: string | null;
  error: string | null;

  // ── Actions: connections & identities ────────────────────────────────────
  fetchConnections: () => Promise<void>;
  testConnection: (id: string) => Promise<void>;
  reauthorizeConnection: (id: string) => Promise<void>;
  disableConnection: (id: string) => Promise<void>;
  enableConnection: (id: string) => Promise<void>;
  discoverIdentities: (connectionId: string) => Promise<void>;
  fetchIdentities: () => Promise<void>;
  refreshIdentityCapabilities: (id: string) => Promise<void>;

  // ── Actions: content ──────────────────────────────────────────────────────
  fetchPosts: () => Promise<void>;
  fetchPostDetail: (id: string) => Promise<void>;
  createPost: (payload: Partial<SOPost>) => Promise<void>;
  updatePost: (id: string, payload: Partial<SOPost>) => Promise<void>;
  submitPostForReview: (id: string) => Promise<void>;
  approvePost: (id: string) => Promise<void>;
  rejectPost: (id: string, reason: string) => Promise<void>;
  requestPostChanges: (id: string, reason: string) => Promise<void>;
  fetchApprovalQueue: () => Promise<void>;
  fetchMedia: () => Promise<void>;
  deleteMedia: (id: string) => Promise<void>;

  // ── Actions: publishing ───────────────────────────────────────────────────
  fetchPublications: () => Promise<void>;
  publishPostNow: (postId: string) => Promise<void>;
  schedulePost: (postId: string, scheduledFor: string) => Promise<void>;
  retryPublication: (id: string) => Promise<void>;
  cancelPublication: (id: string) => Promise<void>;

  // ── Actions: content library ──────────────────────────────────────────────
  fetchContentItems: () => Promise<void>;
  syncIdentityContent: (identityId: string) => Promise<void>;

  // ── Actions: inbox & moderation ───────────────────────────────────────────
  fetchConversations: () => Promise<void>;
  replyConversation: (id: string, text: string) => Promise<void>;
  resolveConversation: (id: string) => Promise<void>;
  fetchComments: () => Promise<void>;
  hideComment: (id: string) => Promise<void>;
  escalateComment: (id: string, classification: string) => Promise<void>;
  fetchEscalations: () => Promise<void>;

  // ── Actions: operations monitor ───────────────────────────────────────────
  fetchJobs: () => Promise<void>;
  retryJob: (id: string) => Promise<void>;
  cancelJob: (id: string) => Promise<void>;

  // ── Actions: settings ─────────────────────────────────────────────────────
  fetchSettings: () => Promise<void>;
  updateSettings: (payload: Partial<SOSettings>) => Promise<void>;

  clearError: () => void;
}

export const useSocialOperationsStore = create<SocialOperationsState>((set, get) => ({
  connections: [], isLoadingConnections: false,
  identities: [], isLoadingIdentities: false,

  posts: [], isLoadingPosts: false,
  selectedPost: null, isLoadingPostDetail: false,
  approvalQueue: [], isLoadingApprovalQueue: false,
  media: [], isLoadingMedia: false,

  publications: [], isLoadingPublications: false,

  contentItems: [], isLoadingContentItems: false,

  conversations: [], isLoadingConversations: false,
  comments: [], isLoadingComments: false,
  escalations: [], isLoadingEscalations: false,

  jobs: [], isLoadingJobs: false,

  settings: null, isLoadingSettings: false,

  actionLoading: null,
  error: null,

  // ── Connections & identities ─────────────────────────────────────────────
  fetchConnections: async () => {
    set({ isLoadingConnections: true, error: null });
    try {
      const connections = await fetchSOConnections();
      set({ connections, isLoadingConnections: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch connections", isLoadingConnections: false });
    }
  },
  testConnection: async (id) => {
    set({ actionLoading: `test-${id}` });
    try {
      await testSOConnection(id);
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Connection test failed", actionLoading: null });
    }
  },
  reauthorizeConnection: async (id) => {
    set({ actionLoading: id });
    try {
      await reauthorizeSOConnection(id);
      await get().fetchConnections();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to reauthorize connection", actionLoading: null });
    }
  },
  disableConnection: async (id) => {
    set({ actionLoading: id });
    try {
      await disableSOConnection(id);
      await get().fetchConnections();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to disable connection", actionLoading: null });
    }
  },
  enableConnection: async (id) => {
    set({ actionLoading: id });
    try {
      await enableSOConnection(id);
      await get().fetchConnections();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to enable connection", actionLoading: null });
    }
  },
  discoverIdentities: async (connectionId) => {
    set({ actionLoading: connectionId });
    try {
      await discoverSOIdentities(connectionId);
      await get().fetchIdentities();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to discover identities", actionLoading: null });
    }
  },
  fetchIdentities: async () => {
    set({ isLoadingIdentities: true, error: null });
    try {
      const identities = await fetchSOIdentities();
      set({ identities, isLoadingIdentities: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch identities", isLoadingIdentities: false });
    }
  },
  refreshIdentityCapabilities: async (id) => {
    set({ actionLoading: id });
    try {
      const identity = await refreshSOIdentityCapabilities(id);
      set((s) => ({
        identities: s.identities.map((i) => (i.id === id ? identity : i)),
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to refresh capabilities", actionLoading: null });
    }
  },

  // ── Content ────────────────────────────────────────────────────────────────
  fetchPosts: async () => {
    set({ isLoadingPosts: true, error: null });
    try {
      const posts = await fetchSOPosts();
      set({ posts, isLoadingPosts: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch posts", isLoadingPosts: false });
    }
  },
  fetchPostDetail: async (id) => {
    set({ isLoadingPostDetail: true, error: null });
    try {
      const post = await fetchSOPost(id);
      set({ selectedPost: post, isLoadingPostDetail: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch post", isLoadingPostDetail: false });
    }
  },
  createPost: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createSOPost(payload);
      await get().fetchPosts();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to create post", actionLoading: null });
    }
  },
  updatePost: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateSOPost(id, payload);
      await get().fetchPosts();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to update post", actionLoading: null });
    }
  },
  submitPostForReview: async (id) => {
    set({ actionLoading: id });
    try {
      await submitSOPostForReview(id);
      await get().fetchPosts();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to submit post", actionLoading: null });
    }
  },
  approvePost: async (id) => {
    set({ actionLoading: id });
    try {
      await approveSOPost(id);
      await get().fetchApprovalQueue();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to approve post", actionLoading: null });
    }
  },
  rejectPost: async (id, reason) => {
    set({ actionLoading: id });
    try {
      await rejectSOPost(id, reason);
      await get().fetchApprovalQueue();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to reject post", actionLoading: null });
    }
  },
  requestPostChanges: async (id, reason) => {
    set({ actionLoading: id });
    try {
      await requestSOPostChanges(id, reason);
      await get().fetchApprovalQueue();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to request changes", actionLoading: null });
    }
  },
  fetchApprovalQueue: async () => {
    set({ isLoadingApprovalQueue: true, error: null });
    try {
      const approvalQueue = await fetchSOApprovalQueue();
      set({ approvalQueue, isLoadingApprovalQueue: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch approval queue", isLoadingApprovalQueue: false });
    }
  },
  fetchMedia: async () => {
    set({ isLoadingMedia: true, error: null });
    try {
      const media = await fetchSOMedia();
      set({ media, isLoadingMedia: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch media", isLoadingMedia: false });
    }
  },
  deleteMedia: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteSOMedia(id);
      set((s) => ({ media: s.media.filter((m) => m.id !== id), actionLoading: null }));
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to delete media", actionLoading: null });
    }
  },

  // ── Publishing & calendar ────────────────────────────────────────────────
  fetchPublications: async () => {
    set({ isLoadingPublications: true, error: null });
    try {
      const publications = await fetchSOPublications();
      set({ publications, isLoadingPublications: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch publications", isLoadingPublications: false });
    }
  },
  publishPostNow: async (postId) => {
    set({ actionLoading: postId });
    try {
      await publishSOPostNow(postId);
      await get().fetchPublications();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to publish post", actionLoading: null });
    }
  },
  schedulePost: async (postId, scheduledFor) => {
    set({ actionLoading: postId });
    try {
      await scheduleSOPost(postId, scheduledFor);
      await get().fetchPosts();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to schedule post", actionLoading: null });
    }
  },
  retryPublication: async (id) => {
    set({ actionLoading: id });
    try {
      await retrySOPublication(id);
      await get().fetchPublications();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to retry publication", actionLoading: null });
    }
  },
  cancelPublication: async (id) => {
    set({ actionLoading: id });
    try {
      await cancelSOPublication(id);
      await get().fetchPublications();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to cancel publication", actionLoading: null });
    }
  },

  // ── Provider content library ─────────────────────────────────────────────
  fetchContentItems: async () => {
    set({ isLoadingContentItems: true, error: null });
    try {
      const contentItems = await fetchSOContentItems();
      set({ contentItems, isLoadingContentItems: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch content", isLoadingContentItems: false });
    }
  },
  syncIdentityContent: async (identityId) => {
    set({ actionLoading: identityId });
    try {
      await syncSOIdentityContent(identityId);
      await get().fetchContentItems();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to sync content", actionLoading: null });
    }
  },

  // ── Inbox & moderation ────────────────────────────────────────────────────
  fetchConversations: async () => {
    set({ isLoadingConversations: true, error: null });
    try {
      const conversations = await fetchSOConversations();
      set({ conversations, isLoadingConversations: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch conversations", isLoadingConversations: false });
    }
  },
  replyConversation: async (id, text) => {
    set({ actionLoading: id });
    try {
      await replySOConversation(id, text);
      await get().fetchConversations();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to send reply", actionLoading: null });
    }
  },
  resolveConversation: async (id) => {
    set({ actionLoading: id });
    try {
      await resolveSOConversation(id);
      await get().fetchConversations();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to resolve conversation", actionLoading: null });
    }
  },
  fetchComments: async () => {
    set({ isLoadingComments: true, error: null });
    try {
      const comments = await fetchSOComments();
      set({ comments, isLoadingComments: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch comments", isLoadingComments: false });
    }
  },
  hideComment: async (id) => {
    set({ actionLoading: id });
    try {
      await hideSOComment(id);
      await get().fetchComments();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to hide comment", actionLoading: null });
    }
  },
  escalateComment: async (id, classification) => {
    set({ actionLoading: id });
    try {
      await escalateSOComment(id, classification);
      await get().fetchComments();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to escalate comment", actionLoading: null });
    }
  },
  fetchEscalations: async () => {
    set({ isLoadingEscalations: true, error: null });
    try {
      const escalations = await fetchSOEscalations();
      set({ escalations, isLoadingEscalations: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch escalations", isLoadingEscalations: false });
    }
  },

  // ── Operations monitor ────────────────────────────────────────────────────
  fetchJobs: async () => {
    set({ isLoadingJobs: true, error: null });
    try {
      const jobs = await fetchSOJobs();
      set({ jobs, isLoadingJobs: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch jobs", isLoadingJobs: false });
    }
  },
  retryJob: async (id) => {
    set({ actionLoading: id });
    try {
      await retrySOJob(id);
      await get().fetchJobs();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to retry job", actionLoading: null });
    }
  },
  cancelJob: async (id) => {
    set({ actionLoading: id });
    try {
      await cancelSOJob(id);
      await get().fetchJobs();
      set({ actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to cancel job", actionLoading: null });
    }
  },

  // ── Settings ──────────────────────────────────────────────────────────────
  fetchSettings: async () => {
    set({ isLoadingSettings: true, error: null });
    try {
      const settings = await fetchSOSettings();
      set({ settings, isLoadingSettings: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch settings", isLoadingSettings: false });
    }
  },
  updateSettings: async (payload) => {
    set({ actionLoading: "settings" });
    try {
      const settings = await updateSOSettings(payload);
      set({ settings, actionLoading: null });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to update settings", actionLoading: null });
    }
  },

  clearError: () => set({ error: null }),
}));