import { create } from "zustand";
import { persist } from "zustand/middleware";
import profileService from "@/lib/profile.service";
import type {
  Profile,
  ProjectItem,
  UpdatePersonalInfoPayload,
  UpdateContactInfoPayload,
  UpdateEmergencyContactPayload,
  UpdateSocialLinksPayload,
  UpdateEducationPayload,
  AddReportPayload,
  ProjectDetail,
  TaskItem,
  TaskDetail,
  TeamItem,
} from "@/types/profile.types";

interface ProfileState {
  profile: Profile | null;
  isLoading: boolean;
  isUpdatingAvatar: boolean;
  isUpdatingProfile: boolean;
  isUpdatingReports: boolean;
  error: string | null;

  // Projects
  projects: ProjectItem[];
  isLoadingProjects: boolean;
  fetchMyProjects: () => Promise<void>;

  // Project Detail
  projectDetail: ProjectDetail | null;
  isLoadingProjectDetail: boolean;
  fetchMyProjectDetail: (projectId: string) => Promise<void>;

  // Tasks
  tasks: TaskItem[];
  isLoadingTasks: boolean;
  fetchMyTasks: () => Promise<void>;

  // Task Detail
  taskDetail: TaskDetail | null;
  isLoadingTaskDetail: boolean;
  fetchMyTaskDetail: (taskId: string) => Promise<void>;

  // Teams
  teams: TeamItem[];
  isLoadingTeams: boolean;
  fetchMyTeams: () => Promise<void>;

  // Fetch
  fetchProfile: () => Promise<void>;

  // Avatar
  updateAvatar: (file: File) => Promise<void>;

  // Profile sections
  updatePersonalInfo: (payload: UpdatePersonalInfoPayload) => Promise<void>;
  updateContactInfo: (payload: UpdateContactInfoPayload) => Promise<void>;
  updateEmergencyContact: (payload: UpdateEmergencyContactPayload) => Promise<void>;
  updateSocialLinks: (payload: UpdateSocialLinksPayload) => Promise<void>;
  updateEducation: (payload: UpdateEducationPayload) => Promise<void>;

  // Documents
  downloadDocument: (documentId: string) => Promise<string>;

  // Reports
  addReport: (payload: AddReportPayload) => Promise<void>;
  downloadReport: (reportId: string) => Promise<string>;
  updateReport: (reportId: string, payload: Partial<AddReportPayload>) => Promise<void>;
  deleteReport: (reportId: string) => Promise<void>;

  // Utilities
  clearError: () => void;
  clearProfile: () => void;
}

export const useProfileStore = create<ProfileState>()(
  persist(
    (set, get) => ({
      profile: null,
      isLoading: false,
      isUpdatingAvatar: false,
      isUpdatingProfile: false,
      isUpdatingReports: false,
      error: null,

      // Projects
      projects: [],
      isLoadingProjects: false,

      projectDetail: null,
      isLoadingProjectDetail: false,

      tasks: [],
      isLoadingTasks: false,

      taskDetail: null,
      isLoadingTaskDetail: false,

      teams: [],
      isLoadingTeams: false,

      // Projects
      fetchMyProjects: async () => {
        set({ isLoadingProjects: true, error: null });
        try {
          const projects = await profileService.getMyProjects();
          set({ projects, isLoadingProjects: false });
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to load projects",
            isLoadingProjects: false,
          });
        }
      },

      fetchMyProjectDetail: async (projectId: string) => {
        set({ isLoadingProjectDetail: true, error: null });
        try {
          const projectDetail = await profileService.getMyProjectDetail(projectId);
          set({
            projectDetail,
            isLoadingProjectDetail: false,
          });
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to load project",
            isLoadingProjectDetail: false,
          });
        }
      },

      fetchMyTasks: async () => {
        set({ isLoadingTasks: true, error: null });
        try {
          const tasks = await profileService.getMyTasks();
          set({
            tasks,
            isLoadingTasks: false,
          });
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to load tasks",
            isLoadingTasks: false,
          });
        }
      },

      fetchMyTaskDetail: async (taskId: string) => {
        set({ isLoadingTaskDetail: true, error: null });
        try {
          const taskDetail = await profileService.getMyTaskDetail(taskId);
          set({
            taskDetail,
            isLoadingTaskDetail: false,
          });
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to load task",
            isLoadingTaskDetail: false,
          });
        }
      },

      fetchMyTeams: async () => {
        set({ isLoadingTeams: true, error: null });
        try {
          const teams = await profileService.getMyTeams();
          set({
            teams,
            isLoadingTeams: false,
          });
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to load teams",
            isLoadingTeams: false,
          });
        }
      },

      // Fetch
      fetchProfile: async () => {
        set({ isLoading: true, error: null });
        try {
          const profile = await profileService.getMyProfile();
          set({ profile, isLoading: false });
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to load profile",
            isLoading: false,
          });
        }
      },

      // Avatar
      updateAvatar: async (file: File) => {
        set({ isUpdatingAvatar: true, error: null });
        try {
          const result = await profileService.updateAvatar(file);
          set((state) => ({
            profile: state.profile
              ? { ...state.profile, avatarUrl: result.avatarUrl }
              : state.profile,
            isUpdatingAvatar: false,
          }));
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to update avatar",
            isUpdatingAvatar: false,
          });
          throw err;
        }
      },

      // Personal Info
      updatePersonalInfo: async (payload) => {
        set({ isUpdatingProfile: true, error: null });
        try {
          const updated = await profileService.updatePersonalInfo(payload);
          set((state) => ({
            profile: state.profile
              ? { ...state.profile, ...updated }
              : state.profile,
            isUpdatingProfile: false,
          }));
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to update personal info",
            isUpdatingProfile: false,
          });
          throw err;
        }
      },

      // Contact Info
      updateContactInfo: async (payload) => {
        set({ isUpdatingProfile: true, error: null });
        try {
          const updated = await profileService.updateContactInfo(payload);
          set((state) => ({
            profile: state.profile
              ? { ...state.profile, ...updated }
              : state.profile,
            isUpdatingProfile: false,
          }));
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to update contact info",
            isUpdatingProfile: false,
          });
          throw err;
        }
      },

      // Emergency Contact
      updateEmergencyContact: async (payload) => {
        set({ isUpdatingProfile: true, error: null });
        try {
          const updated = await profileService.updateEmergencyContact(payload);
          set((state) => ({
            profile: state.profile
              ? { ...state.profile, ...updated }
              : state.profile,
            isUpdatingProfile: false,
          }));
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to update emergency contact",
            isUpdatingProfile: false,
          });
          throw err;
        }
      },

      // Social Links
      updateSocialLinks: async (payload) => {
        set({ isUpdatingProfile: true, error: null });
        try {
          const socialLinks = await profileService.updateSocialLinks(payload);
          set((state) => ({
            profile: state.profile
              ? { ...state.profile, socialLinks }
              : state.profile,
            isUpdatingProfile: false,
          }));
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to update social links",
            isUpdatingProfile: false,
          });
          throw err;
        }
      },

      // Education
      updateEducation: async (payload) => {
        set({ isUpdatingProfile: true, error: null });
        try {
          const educations = await profileService.updateEducation(payload);
          set((state) => ({
            profile: state.profile
              ? { ...state.profile, educations }
              : state.profile,
            isUpdatingProfile: false,
          }));
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to update education",
            isUpdatingProfile: false,
          });
          throw err;
        }
      },

      // Documents
      downloadDocument: async (documentId: string) => {
        try {
          const result = await profileService.getDocumentDownloadUrl(documentId);
          return result.url;
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to get download URL",
          });
          throw err;
        }
      },

      // Reports
      addReport: async (payload) => {
        set({ isUpdatingReports: true, error: null });
        try {
          const report = await profileService.addReport(payload);
          set((state) => ({
            profile: state.profile
              ? { ...state.profile, reports: [report, ...state.profile.reports] }
              : state.profile,
            isUpdatingReports: false,
          }));
        } catch (err: any) {
          set({
            error: err.response?.data?.message || "Failed to add report",
            isUpdatingReports: false,
          });
          throw err;
        }
      },

      downloadReport: async (reportId: string) => {
        try {
          const result = await profileService.getReportDownloadUrl(reportId);
          return result.url;
        } catch (err: any) {
          set({ error: err.response?.data?.message || "Failed to get download URL" });
          throw err;
        }
      },

      updateReport: async (reportId, payload) => {
        set({ isUpdatingReports: true, error: null });
        try {
          const updated = await profileService.updateReport(reportId, payload);
          set((state) => ({
            profile: state.profile
              ? {
                  ...state.profile,
                  reports: state.profile.reports.map((r) =>
                    r.id === reportId ? updated : r
                  ),
                }
              : state.profile,
            isUpdatingReports: false,
          }));
        } catch (err: any) {
          set({ error: err.response?.data?.message || "Failed to update report", isUpdatingReports: false });
          throw err;
        }
      },

      deleteReport: async (reportId) => {
        set({ isUpdatingReports: true, error: null });
        try {
          await profileService.deleteReport(reportId);
          set((state) => ({
            profile: state.profile
              ? {
                  ...state.profile,
                  reports: state.profile.reports.filter((r) => r.id !== reportId),
                }
              : state.profile,
            isUpdatingReports: false,
          }));
        } catch (err: any) {
          set({ error: err.response?.data?.message || "Failed to delete report", isUpdatingReports: false });
          throw err;
        }
      },

      // Utilities
      clearError: () => set({ error: null }),
      
      clearProfile: () =>
        set({
          profile: null,
          projects: [],
          projectDetail: null,
          tasks: [],
          taskDetail: null,
          teams: [],
          error: null,
        }),
    }),
    {
      name: "profile-storage",
      version: 1,
      partialize: (state) => ({
        profile: state.profile,
      }),
    }
  )
);