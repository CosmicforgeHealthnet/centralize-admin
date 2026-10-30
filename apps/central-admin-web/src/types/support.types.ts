// ── Shared ────────────────────────────────────────────────────────────────────

export interface SupportUser {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
  profileImageUrl: string | null;
}

// ── Stats (GET /support/stats) ────────────────────────────────────────────────

export interface ChangeMetric {
  value: number;
  change: string;
  positive: boolean;
  period: string;
}

export interface TicketTypeStats {
  total: number;
  thisMonth: number;
}

export interface SupportStats {
  total: ChangeMetric;
  resolved: ChangeMetric;
  unresolved: ChangeMetric;
  liveChat: ChangeMetric;
  byType: {
    account: TicketTypeStats;
    dispute: TicketTypeStats;
    insurance: TicketTypeStats;
    report: TicketTypeStats;
  };
}

// ── Tickets (GET /support/tickets) ────────────────────────────────────────────

export type TicketCategory = "account" | "dispute" | "insurance" | "report";
export type TicketStatus = "open" | "pending" | "resolved" | "closed";

export interface SupportTicket {
  id: string;
  ticketCategory: TicketCategory;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  users: SupportUser | null;
  [key: string]: unknown;
}

export interface TicketPagination {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
}

export interface MergedTicketsResponse {
  tickets: SupportTicket[];
  pagination: TicketPagination;
}

export interface TicketsQuery {
  category?: TicketCategory;
  status?: TicketStatus;
  page?: number;
  limit?: number;
}

// ── User Traffic (GET /support/user-traffic) ──────────────────────────────────

export interface TrafficDay {
  day: string;
  value: number;
}

export interface UserTrafficResponse {
  days: TrafficDay[];
  total: number;
  avgPerDay: number;
}

// ── Chats (GET /support/chats) ────────────────────────────────────────────────

export interface ChatParticipant {
  id: string;
  name: string;
  email: string;
  avatar?: string | null;
}

export interface ChatMessage {
  id: string;
  content: string;
  createdAt: string;
  type: string;
}

export interface ChatMessageWithSender extends ChatMessage {
  users: {
    id: string;
    fullName: string;
    profileImageUrl: string | null;
    role: string;
  } | null;
}

export interface SupportChat {
  id: string;
  name: string;
  createdAt: string;
  isClaimed: boolean;
  patient: ChatParticipant | null;
  agent: ChatParticipant | null;
  lastMessage: ChatMessage | null;
}