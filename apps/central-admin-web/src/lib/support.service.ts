import api from "./api";
import type {
  SupportStats,
  MergedTicketsResponse,
  TicketsQuery,
  UserTrafficResponse,
  SupportChat,
  ChatMessageWithSender,
} from "@/types/support.types";

export const fetchSupportStats = async (): Promise<SupportStats> => {
  const { data } = await api.get("/api/support/stats");
  return data.data;
};

export const fetchSupportTickets = async (
  query: TicketsQuery = {}
): Promise<MergedTicketsResponse> => {
  const { data } = await api.get("/api/support/tickets", { params: query });
  return data.data;
};

export const fetchUserTraffic = async (): Promise<UserTrafficResponse> => {
  const { data } = await api.get("/api/support/user-traffic");
  return data.data;
};

export const fetchSupportChats = async (): Promise<SupportChat[]> => {
  const { data } = await api.get("/api/support/chats");
  return data.data;
};

export const fetchChatMessages = async (
  roomId: string
): Promise<ChatMessageWithSender[]> => {
  const { data } = await api.get(`/api/support/chats/${roomId}/messages`);
  return data.data;
};

export const claimSupportChat = async (
  roomId: string
): Promise<{ message: string; roomId: string }> => {
  const { data } = await api.post(`/api/support/chats/${roomId}/claim`);
  return data.data;
};

export const sendSupportChatMessage = async (
  roomId: string,
  content: string
): Promise<ChatMessageWithSender> => {
  const { data } = await api.post(`/api/support/chats/${roomId}/messages`, {
    content,
  });
  return data.data;
};