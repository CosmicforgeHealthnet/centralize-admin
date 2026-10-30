import { create } from "zustand";
import {
  fetchSupportStats,
  fetchSupportTickets,
  fetchUserTraffic,
  fetchSupportChats,
  fetchChatMessages,
  claimSupportChat,
  sendSupportChatMessage,
} from "@/lib/support.service";
import type {
  SupportStats,
  SupportTicket,
  TicketPagination,
  TicketsQuery,
  UserTrafficResponse,
  SupportChat,
  ChatMessageWithSender,
} from "@/types/support.types";
import { readHttpErrorMessage } from "@/lib/error-messages";


interface SupportState {
  // ── Data ──────────────────────────────────────────────
  stats: SupportStats | null;
  tickets: SupportTicket[];
  ticketPagination: TicketPagination | null;
  userTraffic: UserTrafficResponse | null;
  chats: SupportChat[];
  activeChatMessages: ChatMessageWithSender[];
  activeChatRoomId: string | null;

  // ── UI State ──────────────────────────────────────────
  isLoadingStats: boolean;
  isLoadingTickets: boolean;
  isLoadingTraffic: boolean;
  isLoadingChats: boolean;
  isLoadingMessages: boolean;
  isClaimingChat: boolean;
  isSendingMessage: boolean;
  error: string | null;

  // ── Actions ───────────────────────────────────────────
  fetchStats: () => Promise<void>;
  fetchTickets: (query?: TicketsQuery) => Promise<void>;
  fetchUserTraffic: () => Promise<void>;
  fetchChats: () => Promise<void>;
  fetchChatMessages: (roomId: string) => Promise<void>;
  claimChat: (roomId: string) => Promise<void>;
  sendMessage: (roomId: string, content: string) => Promise<void>;
  setActiveChatRoom: (roomId: string | null) => void;
  fetchAll: () => Promise<void>;
  clearError: () => void;
}

export const useSupportStore = create<SupportState>((set) => ({
  // ── Initial State ─────────────────────────────────────
  stats: null,
  tickets: [],
  ticketPagination: null,
  userTraffic: null,
  chats: [],
  activeChatMessages: [],
  activeChatRoomId: null,
  isLoadingStats: false,
  isLoadingTickets: false,
  isLoadingTraffic: false,
  isLoadingChats: false,
  isLoadingMessages: false,
  isClaimingChat: false,
  isSendingMessage: false,
  error: null,

  // ── Actions ───────────────────────────────────────────
  fetchStats: async () => {
    set({ isLoadingStats: true, error: null });
    try {
      const stats = await fetchSupportStats();
      set({ stats, isLoadingStats: false });
    } catch (err: unknown) {
      set({
        error: readHttpErrorMessage(err) || "Failed to fetch support stats",
        isLoadingStats: false,
      });
    }
  },

  fetchTickets: async (query = {}) => {
    set({ isLoadingTickets: true, error: null });
    try {
      const { tickets, pagination } = await fetchSupportTickets(query);
      set({ tickets, ticketPagination: pagination, isLoadingTickets: false });
    } catch (err: unknown) {
      set({
        error: readHttpErrorMessage(err) || "Failed to fetch tickets",
        isLoadingTickets: false,
      });
    }
  },

  fetchUserTraffic: async () => {
    set({ isLoadingTraffic: true, error: null });
    try {
      const userTraffic = await fetchUserTraffic();
      set({ userTraffic, isLoadingTraffic: false });
    } catch (err: unknown) {
      set({
        error: readHttpErrorMessage(err) || "Failed to fetch user traffic",
        isLoadingTraffic: false,
      });
    }
  },

  fetchChats: async () => {
    set({ isLoadingChats: true, error: null });
    try {
      const chats = await fetchSupportChats();
      set({ chats, isLoadingChats: false });
    } catch (err: unknown) {
      set({
        error: readHttpErrorMessage(err) || "Failed to fetch support chats",
        isLoadingChats: false,
      });
    }
  },

  fetchChatMessages: async (roomId: string) => {
    set({ isLoadingMessages: true, error: null });
    try {
      const activeChatMessages = await fetchChatMessages(roomId);
      set({ activeChatMessages, activeChatRoomId: roomId, isLoadingMessages: false });
    } catch (err: unknown) {
      set({
        error: readHttpErrorMessage(err) || "Failed to fetch messages",
        isLoadingMessages: false,
      });
    }
  },

  claimChat: async (roomId: string) => {
    set({ isClaimingChat: true, error: null });
    try {
      await claimSupportChat(roomId);
      // Refresh chats so isClaimed reflects the update
      const chats = await fetchSupportChats();
      set({ chats, isClaimingChat: false });
    } catch (err: unknown) {
      set({
        error: readHttpErrorMessage(err) || "Failed to claim chat",
        isClaimingChat: false,
      });
    }
  },

  sendMessage: async (roomId: string, content: string) => {
    set({ isSendingMessage: true, error: null });
    try {
      const newMessage = await sendSupportChatMessage(roomId, content);
      // Append the new message optimistically into activeChatMessages
      set((state) => ({
        activeChatMessages: [...state.activeChatMessages, newMessage],
        isSendingMessage: false,
      }));
    } catch (err: unknown) {
      set({
        error: readHttpErrorMessage(err) || "Failed to send message",
        isSendingMessage: false,
      });
    }
  },

  setActiveChatRoom: (roomId) => set({ activeChatRoomId: roomId }),

  // Fires stats + tickets + traffic + chats in parallel on page mount
  fetchAll: async () => {
    set({
      isLoadingStats: true,
      isLoadingTickets: true,
      isLoadingTraffic: true,
      isLoadingChats: true,
      error: null,
    });
    try {
      const [stats, ticketsRes, userTraffic, chats] = await Promise.all([
        fetchSupportStats(),
        fetchSupportTickets(),
        fetchUserTraffic(),
        fetchSupportChats(),
      ]);
      set({
        stats,
        tickets: ticketsRes.tickets,
        ticketPagination: ticketsRes.pagination,
        userTraffic,
        chats,
        isLoadingStats: false,
        isLoadingTickets: false,
        isLoadingTraffic: false,
        isLoadingChats: false,
      });
    } catch (err: unknown) {
      set({
        error: readHttpErrorMessage(err) || "Failed to fetch support data",
        isLoadingStats: false,
        isLoadingTickets: false,
        isLoadingTraffic: false,
        isLoadingChats: false,
      });
    }
  },

  clearError: () => set({ error: null }),
}));