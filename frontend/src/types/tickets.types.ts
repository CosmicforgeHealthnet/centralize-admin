// src/types/tickets.types.ts

export type TicketStatus = "pending" | "open" | "in_progress" | "resolved" | "closed" | "failed";
export type TicketCategory = "account" | "dispute" | "insurance" | "report";

export interface TicketUser {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
  profileImageUrl: string | null;
  departmentSpecialty: string | null;
  phoneNumber: string | null;
  isOnline: boolean;
}

export interface Ticket {
  id: string;
  status: TicketStatus;
  issueType?: string;
  priority?: string;
  assignedTo?: string;
  createdAt: string;
  updatedAt: string;
  user: TicketUser | null;
  ticketCategory?: TicketCategory; // added by getAllTicketsMerged
  [key: string]: any; // allow extra fields from each ticket type
}

export interface Dispute {
  id: string;
  status: TicketStatus;
  disputeType?: string;
  createdAt: string;
  updatedAt: string;
  user: TicketUser | null;
  [key: string]: any;
}

export interface InsuranceTicket {
  id: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  user: TicketUser | null;
  [key: string]: any;
}

export interface Report {
  id: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  user: TicketUser | null;
  [key: string]: any;
}

export interface SupportStats {
  total: number;
  resolved: number;
  unresolved: number;
  byType: {
    account: number;
    dispute: number;
    insurance: number;
    report: number;
  };
}

export interface TicketsFilters {
  status?: string;
  issueType?: string;
  priority?: string;
  assignedTo?: string;
  type?: TicketCategory;
}