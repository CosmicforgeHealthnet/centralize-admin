import api from "@/lib/api";
import type {
  Profile,
  UpdatePersonalInfoPayload,
  UpdateContactInfoPayload,
  UpdateEmergencyContactPayload,
  UpdateSocialLinksPayload,
  UpdateEducationPayload,
  AddReportPayload,
  SocialLink,
  Education,
  Report,
  DocumentDownloadResponse,
  ProjectDetail,
  TaskItem,
  TaskDetail,
  TeamItem,
  ProjectItem
} from "@/types/profile.types";

const BASE = "/api/profile";

const profileService = {
  // ── GET /profile/me ────────────────────────────────────────────────────────
  getMyProfile: async (): Promise<Profile> => {
    const res = await api.get(`${BASE}/me`);
    return res.data.data;
  },

  // ── PATCH /profile/me/avatar ───────────────────────────────────────────────
  updateAvatar: async (file: File): Promise<{ avatarUrl: string }> => {
    const formData = new FormData();
    formData.append("avatar", file);
    const res = await api.patch(`${BASE}/me/avatar`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return res.data.data;
  },

  // ── PATCH /profile/me/personal ─────────────────────────────────────────────
  updatePersonalInfo: async (
    payload: UpdatePersonalInfoPayload
  ): Promise<Partial<Profile>> => {
    const res = await api.patch(`${BASE}/me/personal`, payload);
    return res.data.data;
  },

  // ── PATCH /profile/me/contact ──────────────────────────────────────────────
  updateContactInfo: async (
    payload: UpdateContactInfoPayload
  ): Promise<Partial<Profile>> => {
    const res = await api.patch(`${BASE}/me/contact`, payload);
    return res.data.data;
  },

  // ── PATCH /profile/me/emergency ────────────────────────────────────────────
  updateEmergencyContact: async (
    payload: UpdateEmergencyContactPayload
  ): Promise<Partial<Profile>> => {
    const res = await api.patch(`${BASE}/me/emergency`, payload);
    return res.data.data;
  },

  // ── PUT /profile/me/social ─────────────────────────────────────────────────
  updateSocialLinks: async (
    payload: UpdateSocialLinksPayload
  ): Promise<SocialLink[]> => {
    const res = await api.put(`${BASE}/me/social`, payload);
    return res.data.data;
  },

  // ── PUT /profile/me/education ──────────────────────────────────────────────
  updateEducation: async (
    payload: UpdateEducationPayload
  ): Promise<Education[]> => {
    const res = await api.put(`${BASE}/me/education`, payload);
    return res.data.data;
  },

  // ── GET /profile/me/documents/:id/download ─────────────────────────────────
  getDocumentDownloadUrl: async (
    documentId: string
  ): Promise<DocumentDownloadResponse> => {
    const res = await api.get(`${BASE}/me/documents/${documentId}/download`);
    return res.data.data;
  },

  // ── POST /profile/me/reports ───────────────────────────────────────────────
// POST /profile/me/reports
addReport: async (payload: AddReportPayload): Promise<Report> => {
  const formData = new FormData();
  formData.append("title", payload.title);
  if (payload.body) formData.append("body", payload.body);
  if (payload.note) formData.append("note", payload.note);
  
  // Only append file if it exists
  if (payload.file) {
    formData.append("file", payload.file);
  }

  const res = await api.post(`${BASE}/me/reports`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data.data;
},

// GET /profile/me/reports/:id/download
getReportDownloadUrl: async (reportId: string): Promise<DocumentDownloadResponse> => {
  const res = await api.get(`${BASE}/me/reports/${reportId}/download`);
  return res.data.data;
  },
updateReport: async (reportId: string, payload: Partial<AddReportPayload>): Promise<Report> => {
  const formData = new FormData();
  if (payload.file) formData.append("file", payload.file);
  if (payload.title) formData.append("title", payload.title);
  if (payload.body !== undefined) formData.append("body", payload.body ?? "");
  if (payload.note !== undefined) formData.append("note", payload.note ?? "");

  const res = await api.patch(`${BASE}/me/reports/${reportId}`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data.data;
},

deleteReport: async (reportId: string): Promise<void> => {
  await api.delete(`${BASE}/me/reports/${reportId}`);
},

  // ── GET /profile/me/reports/:id ────────────────────────────────────────────
  getReport: async (reportId: string): Promise<Report> => {
    const res = await api.get(`${BASE}/me/reports/${reportId}`);
    return res.data.data;
  },
  getMyProjects: async (): Promise<ProjectItem[]> => {
  const res = await api.get(`${BASE}/me/projects`);
  return res.data.data;
  },
  // ── GET /profile/me/projects/:id ───────────────────────────────────────────
getMyProjectDetail: async (projectId: string): Promise<ProjectDetail> => {
  const res = await api.get(`${BASE}/me/projects/${projectId}`);
  return res.data.data;
},

// ── GET /profile/me/tasks ──────────────────────────────────────────────────
getMyTasks: async (): Promise<TaskItem[]> => {
  const res = await api.get(`${BASE}/me/tasks`);
  return res.data.data;
},

// ── GET /profile/me/tasks/:id ──────────────────────────────────────────────
getMyTaskDetail: async (taskId: string): Promise<TaskDetail> => {
  const res = await api.get(`${BASE}/me/tasks/${taskId}`);
  return res.data.data;
},

// ── GET /profile/me/teams ──────────────────────────────────────────────────
getMyTeams: async (): Promise<TeamItem[]> => {
  const res = await api.get(`${BASE}/me/teams`);
  return res.data.data;
},
};

export default profileService;