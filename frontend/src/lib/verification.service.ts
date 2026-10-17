import api from "./api";
import type {
  VerificationListResponse,
  VerificationSubListResponse,
  VerificationDetail,
  PharmacyVerificationDetail,
  LabVerificationDetail,
  DispatchVerificationDetail,
  VerificationActionResponse,
  DispatchStepActionResponse,
  DispatchSuspendResponse,
  VerificationFilters,
  StuckDoctorResponse,
} from "@/types/verification.types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildParams(filters: Partial<VerificationFilters>): string {
  const params = new URLSearchParams();
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  if (filters.limit && filters.limit !== 10) params.set("limit", String(filters.limit));
  if (filters.status && filters.status !== "All") params.set("status", filters.status);
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if (filters.search) params.set("search", filters.search);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ─── Combined (All tab) ───────────────────────────────────────────────────────

export const fetchAllVerifications = async (
  filters: Partial<VerificationFilters> = {}
): Promise<VerificationListResponse> => {
  const { data } = await api.get(`/api/verification/all${buildParams(filters)}`);
  return data.data;
};

// ─── Doctor Verifications ─────────────────────────────────────────────────────

export const fetchDoctorVerifications = async (
  filters: Partial<VerificationFilters> = {}
): Promise<VerificationListResponse> => {
  const { data } = await api.get(`/api/verification/doctors${buildParams(filters)}`);
  return data.data;
};

export const fetchDoctorVerificationById = async (
  id: string
): Promise<VerificationDetail> => {
  const { data } = await api.get(`/api/verification/doctors/${id}`);
  return data.data;
};

export const approveDoctorVerification = async (
  id: string,
  reviewNotes?: string
): Promise<VerificationActionResponse> => {
  const { data } = await api.patch(`/api/verification/doctors/${id}/approve`, { reviewNotes });
  return data.data;
};

export const rejectDoctorVerification = async (
  id: string,
  rejectionReason: string,
  reviewNotes?: string
): Promise<VerificationActionResponse> => {
  const { data } = await api.patch(`/api/verification/doctors/${id}/reject`, {
    rejectionReason,
    reviewNotes,
  });
  return data.data;
};

// ─── Pharmacy Verifications ───────────────────────────────────────────────────

export const fetchPharmacyVerifications = async (
  filters: Partial<VerificationFilters> = {}
): Promise<VerificationSubListResponse> => {
  const { data } = await api.get(`/api/verification/pharmacies${buildParams(filters)}`);
  return data.data;
};

export const fetchPharmacyVerificationById = async (
  id: string
): Promise<PharmacyVerificationDetail> => {
  const { data } = await api.get(`/api/verification/pharmacies/${id}`);
  return data.data;
};

export const approvePharmacyVerification = async (
  id: string,
  reviewNotes?: string
): Promise<VerificationActionResponse> => {
  const { data } = await api.patch(`/api/verification/pharmacies/${id}/approve`, { reviewNotes });
  return data.data;
};

export const rejectPharmacyVerification = async (
  id: string,
  rejectionReason: string,
  reviewNotes?: string
): Promise<VerificationActionResponse> => {
  const { data } = await api.patch(`/api/verification/pharmacies/${id}/reject`, {
    rejectionReason,
    reviewNotes,
  });
  return data.data;
};

// ─── Lab Verifications ────────────────────────────────────────────────────────

export const fetchLabVerifications = async (
  filters: Partial<VerificationFilters> = {}
): Promise<VerificationSubListResponse> => {
  const { data } = await api.get(`/api/verification/labs${buildParams(filters)}`);
  return data.data;
};

export const fetchLabVerificationById = async (
  id: string
): Promise<LabVerificationDetail> => {
  const { data } = await api.get(`/api/verification/labs/${id}`);
  return data.data;
};

export const approveLabVerification = async (
  id: string
): Promise<VerificationActionResponse> => {
  const { data } = await api.patch(`/api/verification/labs/${id}/approve`);
  return data.data;
};

export const rejectLabVerification = async (
  id: string,
  rejectionReason: string
): Promise<VerificationActionResponse> => {
  const { data } = await api.patch(`/api/verification/labs/${id}/reject`, { rejectionReason });
  return data.data;
};

// ─── Dispatch Verifications ───────────────────────────────────────────────────

export const fetchDispatchVerifications = async (
  filters: Partial<VerificationFilters> = {}
): Promise<VerificationSubListResponse> => {
  const { data } = await api.get(`/api/verification/dispatch${buildParams(filters)}`);
  return data.data;
};

export const fetchDispatchVerificationById = async (
  id: string
): Promise<DispatchVerificationDetail> => {
  const { data } = await api.get(`/api/verification/dispatch/${id}`);
  return data.data;
};

export const approveDispatchStep = async (
  id: string,
  step: string,
  notes?: string
): Promise<DispatchStepActionResponse> => {
  const { data } = await api.patch(`/api/verification/dispatch/${id}/approve-step`, {
    step,
    notes,
  });
  return data.data;
};

export const rejectDispatchStep = async (
  id: string,
  step: string,
  reason: string
): Promise<DispatchStepActionResponse> => {
  const { data } = await api.patch(`/api/verification/dispatch/${id}/reject-step`, {
    step,
    reason,
  });
  return data.data;
};

export const suspendDispatchProvider = async (
  id: string,
  reason: string
): Promise<DispatchSuspendResponse> => {
  const { data } = await api.patch(`/api/verification/dispatch/${id}/suspend`, { reason });
  return data.data;
};

export const unsuspendDispatchProvider = async (
  id: string
): Promise<DispatchSuspendResponse> => {
  const { data } = await api.patch(`/api/verification/dispatch/${id}/unsuspend`);
  return data.data;
};

// ─── Stuck Doctors ─────────────────────────────────────────────────────────────

export const fetchStuckDoctors = async (
  filters: Partial<VerificationFilters> = {}
): Promise<StuckDoctorResponse> => {
  const { data } = await api.get(`/api/verification/stuck-doctors${buildParams(filters)}`);
  return data.data;
};