import { create } from "zustand";
import type {
  AdminSetting,
  AdminSettingsGrouped,
  UpdateSettingPayload,
  SettingHistory,
  SettingHistoryFilters,
} from "@/types/admin-settings.types";
import {
  fetchAllSettings,
  fetchSettingsByCategory,
  fetchSetting,
  updateSetting,
  batchUpdateSettings,
  fetchSettingsHistory,
} from "@/lib/admin-settings.service";
import { readHttpErrorMessage } from "@/lib/error-messages";


interface AdminSettingsState {
  // Settings data
  allSettings: AdminSettingsGrouped | null;
  currentCategory: string | null;
  categorySettings: AdminSetting[];
  currentSetting: AdminSetting | null;

  // History
  history: SettingHistory[];
  historyTotal: number;
  historyPage: number;
  historyLimit: number;

  // UI State
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;

  // Actions
  loadAllSettings: () => Promise<void>;
  loadSettingsByCategory: (category: string) => Promise<void>;
  loadSetting: (category: string, key: string) => Promise<void>;
  saveSetting: (category: string, key: string, value: any) => Promise<void>;
  saveMultipleSettings: (updates: UpdateSettingPayload[]) => Promise<void>;
  loadHistory: (filters?: SettingHistoryFilters) => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

export const useAdminSettingsStore = create<AdminSettingsState>((set, get) => ({
  // Initial state
  allSettings: null,
  currentCategory: null,
  categorySettings: [],
  currentSetting: null,
  history: [],
  historyTotal: 0,
  historyPage: 1,
  historyLimit: 50,
  isLoading: false,
  isSaving: false,
  error: null,

  loadAllSettings: async () => {
    set({ isLoading: true, error: null });
    try {
      const data = await fetchAllSettings();
      set({ allSettings: data, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to load settings", isLoading: false });
    }
  },

  loadSettingsByCategory: async (category: string) => {
    set({ isLoading: true, error: null, currentCategory: category });
    try {
      const data = await fetchSettingsByCategory(category);
      set({ categorySettings: data, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || `Failed to load ${category} settings`, isLoading: false });
    }
  },

  loadSetting: async (category: string, key: string) => {
    set({ isLoading: true, error: null });
    try {
      const data = await fetchSetting(category, key);
      set({ currentSetting: data, isLoading: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to load setting", isLoading: false });
    }
  },

  saveSetting: async (category: string, key: string, value: any) => {
    set({ isSaving: true, error: null });
    try {
      const updated = await updateSetting(category, key, value);

      // Update local cache
      set((state) => {
        // Update in allSettings
        const newAllSettings = state.allSettings ? { ...state.allSettings } : null;
        if (newAllSettings && newAllSettings[category]) {
          const index = newAllSettings[category].findIndex(s => s.key === key);
          if (index !== -1) {
            newAllSettings[category][index] = updated;
          }
        }

        // Update in categorySettings
        const newCategorySettings = [...state.categorySettings];
        const catIndex = newCategorySettings.findIndex(s => s.key === key);
        if (catIndex !== -1) {
          newCategorySettings[catIndex] = updated;
        }

        return {
          allSettings: newAllSettings,
          categorySettings: newCategorySettings,
          currentSetting: updated,
          isSaving: false,
        };
      });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to save setting", isSaving: false });
    }
  },

  saveMultipleSettings: async (updates: UpdateSettingPayload[]) => {
    set({ isSaving: true, error: null });
    try {
      const updated = await batchUpdateSettings(updates);

      // Refresh current category settings if needed
      const { currentCategory } = get();
      if (currentCategory) {
        await get().loadSettingsByCategory(currentCategory);
      }

      set({ isSaving: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to save settings", isSaving: false });
    }
  },

  loadHistory: async (filters?: SettingHistoryFilters) => {
    set({ isLoading: true, error: null });
    try {
      const result = await fetchSettingsHistory(filters || {});
      set({ 
        history: result.data, 
        historyTotal: result.total,
        historyPage: result.page,
        historyLimit: result.limit,
        isLoading: false 
      });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) || "Failed to load history", isLoading: false });
    }
  },

  clearError: () => set({ error: null }),

  reset: () => set({
    allSettings: null,
    currentCategory: null,
    categorySettings: [],
    currentSetting: null,
    history: [],
    historyTotal: 0,
    historyPage: 1,
    error: null,
  }),
}));