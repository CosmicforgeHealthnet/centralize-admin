// src/lib/tickets.service.ts

import api from "./api";
import type {
  Ticket,
  Dispute,
  InsuranceTicket,
  Report,
  SupportStats,
  TicketsFilters,
} from "@/types/tickets.types";

// ── Account Tickets ───────────────────────────────────

export const fetchAllTickets = async (filters: TicketsFilters = {}): Promise<Ticket[]> => {
  const { data } = await api.get("/api/tickets", { params: filters });
  return data.data;
};

export const fetchTicketById = async (id: string): Promise<Ticket> => {
  const { data } = await api.get(`/api/tickets/${id}`);
  return data.data;
};

export const updateTicket = async (id: string, payload: Partial<Ticket>): Promise<Ticket> => {
  const { data } = await api.put(`/api/tickets/${id}`, payload);
  return data.data;
};

export const assignTicket = async (id: string, assignedTo: string): Promise<Ticket> => {
  const { data } = await api.post(`/api/tickets/${id}/assign`, { assignedTo });
  return data.data;
};

export const resolveTicket = async (id: string, resolutionNotes?: string): Promise<Ticket> => {
  const { data } = await api.post(`/api/tickets/${id}/resolve`, { resolutionNotes });
  return data.data;
};

// ── Disputes ──────────────────────────────────────────

export const fetchAllDisputes = async (filters: Pick<TicketsFilters, "status"> & { disputeType?: string } = {}): Promise<Dispute[]> => {
  const { data } = await api.get("/api/tickets/disputes", { params: filters });
  return data.data;
};

export const fetchDisputeById = async (id: string): Promise<Dispute> => {
  const { data } = await api.get(`/api/tickets/disputes/${id}`);
  return data.data;
};

export const updateDispute = async (id: string, payload: Partial<Dispute>): Promise<Dispute> => {
  const { data } = await api.put(`/api/tickets/disputes/${id}`, payload);
  return data.data;
};

// ── Insurance ─────────────────────────────────────────

export const fetchAllInsuranceTickets = async (filters: Pick<TicketsFilters, "status"> = {}): Promise<InsuranceTicket[]> => {
  const { data } = await api.get("/api/tickets/insurance", { params: filters });
  return data.data;
};

export const fetchInsuranceTicketById = async (id: string): Promise<InsuranceTicket> => {
  const { data } = await api.get(`/api/tickets/insurance/${id}`);
  return data.data;
};

export const updateInsuranceTicket = async (id: string, payload: Partial<InsuranceTicket>): Promise<InsuranceTicket> => {
  const { data } = await api.put(`/api/tickets/insurance/${id}`, payload);
  return data.data;
};

// ── Reports ───────────────────────────────────────────

export const fetchAllReports = async (filters: Pick<TicketsFilters, "status"> = {}): Promise<Report[]> => {
  const { data } = await api.get("/api/tickets/reports", { params: filters });
  return data.data;
};

export const fetchReportById = async (id: string): Promise<Report> => {
  const { data } = await api.get(`/api/tickets/reports/${id}`);
  return data.data;
};

export const updateReport = async (id: string, payload: Partial<Report>): Promise<Report> => {
  const { data } = await api.put(`/api/tickets/reports/${id}`, payload);
  return data.data;
};

// ── Aggregators ───────────────────────────────────────

// Powers: HelpStatCards + TicketTypeChart
export const fetchSupportStats = async (): Promise<SupportStats> => {
  const { data } = await api.get("/api/tickets/stats");
  return data.data;
};

// Powers: RecentTickets table (all types merged + sorted)
export const fetchAllTicketsMerged = async (filters: TicketsFilters = {}): Promise<Ticket[]> => {
  const { data } = await api.get("/api/tickets/all", { params: filters });
  return data.data;
};