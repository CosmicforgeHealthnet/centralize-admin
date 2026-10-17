// src/stores/tickets.store.ts

import { create } from "zustand";
import {
  fetchAllTickets,
  fetchTicketById,
  fetchAllDisputes,
  fetchDisputeById,
  fetchAllInsuranceTickets,
  fetchAllReports,
  fetchSupportStats,
  fetchAllTicketsMerged,
  assignTicket,
  resolveTicket,
  updateTicket,
  updateDispute,
  updateInsuranceTicket,
  updateReport,
} from "@/lib/tickets.service";
import type {
  Ticket,
  Dispute,
  InsuranceTicket,
  Report,
  SupportStats,
  TicketsFilters,
} from "@/types/tickets.types";
import { readHttpErrorMessage } from "@/lib/error-messages";


interface TicketsState {
  // ── Data ──────────────────────────────────────────────
  tickets: Ticket[];
  mergedTickets: Ticket[];       // all types merged — for RecentTickets table
  disputes: Dispute[];
  insuranceTickets: InsuranceTicket[];
  reports: Report[];
  selectedTicket: Ticket | null;
  selectedDispute: Dispute | null;
  stats: SupportStats | null;    // for HelpStatCards + TicketTypeChart

  // ── UI State ──────────────────────────────────────────
  isLoading: boolean;
  isActionLoading: boolean;      // for assign/resolve/update operations
  error: string | null;
  filters: TicketsFilters;

  // ── Actions ───────────────────────────────────────────
  fetchTickets: (filters?: TicketsFilters) => Promise<void>;
  fetchMergedTickets: (filters?: TicketsFilters) => Promise<void>;
  fetchTicket: (id: string) => Promise<void>;
  fetchDisputes: (filters?: { status?: string; disputeType?: string }) => Promise<void>;
  fetchDispute: (id: string) => Promise<void>;
  fetchInsuranceTickets: (filters?: { status?: string }) => Promise<void>;
  fetchReports: (filters?: { status?: string }) => Promise<void>;
  fetchStats: () => Promise<void>;

  assignTicket: (id: string, assignedTo: string) => Promise<void>;
  resolveTicket: (id: string, resolutionNotes?: string) => Promise<void>;
  updateTicket: (id: string, payload: Partial<Ticket>) => Promise<void>;
  updateDispute: (id: string, payload: Partial<Dispute>) => Promise<void>;
  updateInsuranceTicket: (id: string, payload: Partial<InsuranceTicket>) => Promise<void>;
  updateReport: (id: string, payload: Partial<Report>) => Promise<void>;

  setFilters: (filters: TicketsFilters) => void;
  clearError: () => void;
  clearSelected: () => void;
}

export const useTicketsStore = create<TicketsState>((set, get) => ({
  // ── Initial State ─────────────────────────────────────
  tickets: [],
  mergedTickets: [],
  disputes: [],
  insuranceTickets: [],
  reports: [],
  selectedTicket: null,
  selectedDispute: null,
  stats: null,
  isLoading: false,
  isActionLoading: false,
  error: null,
  filters: {},

  // ── Fetch Actions ─────────────────────────────────────

  fetchTickets: async (filters) => {
    set({ isLoading: true, error: null });
    try {
      const tickets = await fetchAllTickets(filters ?? get().filters);
      set({ tickets, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch tickets", isLoading: false });
    }
  },

  fetchMergedTickets: async (filters) => {
    set({ isLoading: true, error: null });
    try {
      const mergedTickets = await fetchAllTicketsMerged(filters ?? get().filters);
      set({ mergedTickets, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch tickets", isLoading: false });
    }
  },

  fetchTicket: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const selectedTicket = await fetchTicketById(id);
      set({ selectedTicket, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch ticket", isLoading: false });
    }
  },

  fetchDisputes: async (filters) => {
    set({ isLoading: true, error: null });
    try {
      const disputes = await fetchAllDisputes(filters);
      set({ disputes, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch disputes", isLoading: false });
    }
  },

  fetchDispute: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const selectedDispute = await fetchDisputeById(id);
      set({ selectedDispute, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch dispute", isLoading: false });
    }
  },

  fetchInsuranceTickets: async (filters) => {
    set({ isLoading: true, error: null });
    try {
      const insuranceTickets = await fetchAllInsuranceTickets(filters);
      set({ insuranceTickets, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch insurance tickets", isLoading: false });
    }
  },

  fetchReports: async (filters) => {
    set({ isLoading: true, error: null });
    try {
      const reports = await fetchAllReports(filters);
      set({ reports, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch reports", isLoading: false });
    }
  },

  fetchStats: async () => {
    set({ isLoading: true, error: null });
    try {
      const stats = await fetchSupportStats();
      set({ stats, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to fetch support stats", isLoading: false });
    }
  },

  // ── Mutation Actions ──────────────────────────────────

  assignTicket: async (id, assignedTo) => {
    set({ isActionLoading: true, error: null });
    try {
      const updated = await assignTicket(id, assignedTo);
      set((state) => ({
        tickets: state.tickets.map((t) => (t.id === id ? updated : t)),
        mergedTickets: state.mergedTickets.map((t) => (t.id === id ? updated : t)),
        selectedTicket: state.selectedTicket?.id === id ? updated : state.selectedTicket,
        isActionLoading: false,
      }));
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to assign ticket", isActionLoading: false });
    }
  },

  resolveTicket: async (id, resolutionNotes) => {
    set({ isActionLoading: true, error: null });
    try {
      const updated = await resolveTicket(id, resolutionNotes);
      set((state) => ({
        tickets: state.tickets.map((t) => (t.id === id ? updated : t)),
        mergedTickets: state.mergedTickets.map((t) => (t.id === id ? updated : t)),
        selectedTicket: state.selectedTicket?.id === id ? updated : state.selectedTicket,
        isActionLoading: false,
      }));
      // Refresh stats after resolve so HelpStatCards updates
      get().fetchStats();
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to resolve ticket", isActionLoading: false });
    }
  },

  updateTicket: async (id, payload) => {
    set({ isActionLoading: true, error: null });
    try {
      const updated = await updateTicket(id, payload);
      set((state) => ({
        tickets: state.tickets.map((t) => (t.id === id ? updated : t)),
        mergedTickets: state.mergedTickets.map((t) => (t.id === id ? updated : t)),
        isActionLoading: false,
      }));
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to update ticket", isActionLoading: false });
    }
  },

  updateDispute: async (id, payload) => {
    set({ isActionLoading: true, error: null });
    try {
      const updated = await updateDispute(id, payload);
      set((state) => ({
        disputes: state.disputes.map((d) => (d.id === id ? updated : d)),
        isActionLoading: false,
      }));
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to update dispute", isActionLoading: false });
    }
  },

  updateInsuranceTicket: async (id, payload) => {
    set({ isActionLoading: true, error: null });
    try {
      const updated = await updateInsuranceTicket(id, payload);
      set((state) => ({
        insuranceTickets: state.insuranceTickets.map((t) => (t.id === id ? updated : t)),
        isActionLoading: false,
      }));
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to update insurance ticket", isActionLoading: false });
    }
  },

  updateReport: async (id, payload) => {
    set({ isActionLoading: true, error: null });
    try {
      const updated = await updateReport(id, payload);
      set((state) => ({
        reports: state.reports.map((r) => (r.id === id ? updated : r)),
        isActionLoading: false,
      }));
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to update report", isActionLoading: false });
    }
  },

  // ── Utility ───────────────────────────────────────────

  setFilters: (filters) => set({ filters }),
  clearError: () => set({ error: null }),
  clearSelected: () => set({ selectedTicket: null, selectedDispute: null }),
}));