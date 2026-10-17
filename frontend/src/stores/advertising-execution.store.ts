import { create } from "zustand";
import type {
  AEExecutionSafetyState,
  AEProvider,
  AEPlanFilters,
  AERunFilters,
  AEIncidentFilters,
} from "@/types/advertising-execution.types";

interface AEStore {
  // Safety banner — set once from Overview/Health fetch, read by every screen's persistent banner.
  safety: AEExecutionSafetyState | null;
  setSafety: (safety: AEExecutionSafetyState) => void;

  // Preserved provider/connection context as the user moves between Plans, Runs, Incidents, Creatives.
  activeProvider: AEProvider | "all";
  activeConnectionId: string | "all";
  setActiveProviderContext: (provider: AEProvider | "all", connectionId: string | "all") => void;

  // In-progress Create Plan draft context (Section 7.4) — carried across the stepper before a plan ID exists.
  draftPlanContext: {
    provider: AEProvider | null;
    connectionId: string | null;
    accountId: string | null;
    currency: string | null;
  } | null;
  setDraftPlanContext: (ctx: AEStore["draftPlanContext"]) => void;
  clearDraftPlanContext: () => void;

  // List filters preserved per section so returning to a list doesn't reset the user's view.
  planFilters: Partial<AEPlanFilters>;
  setPlanFilters: (filters: Partial<AEPlanFilters>) => void;

  runFilters: Partial<AERunFilters>;
  setRunFilters: (filters: Partial<AERunFilters>) => void;

  incidentFilters: Partial<AEIncidentFilters>;
  setIncidentFilters: (filters: Partial<AEIncidentFilters>) => void;

  reset: () => void;
}

const initialState = {
  safety: null,
  activeProvider: "all" as const,
  activeConnectionId: "all" as const,
  draftPlanContext: null,
  planFilters: {},
  runFilters: {},
  incidentFilters: {},
};

export const useAdvertisingExecutionStore = create<AEStore>((set) => ({
  ...initialState,

  setSafety: (safety) => set({ safety }),

  setActiveProviderContext: (provider, connectionId) =>
    set({ activeProvider: provider, activeConnectionId: connectionId }),

  setDraftPlanContext: (ctx) => set({ draftPlanContext: ctx }),
  clearDraftPlanContext: () => set({ draftPlanContext: null }),

  setPlanFilters: (filters) => set((state) => ({ planFilters: { ...state.planFilters, ...filters } })),
  setRunFilters: (filters) => set((state) => ({ runFilters: { ...state.runFilters, ...filters } })),
  setIncidentFilters: (filters) => set((state) => ({ incidentFilters: { ...state.incidentFilters, ...filters } })),

  reset: () => set(initialState),
}));