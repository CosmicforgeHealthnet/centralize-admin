import api from "./api";
import type {
  HealthnetMetrics,
  HealthnetActivityChart,
  HealthnetPatientsChart,
  HealthnetRevenueChart,
  AppointmentsResponse,
  AppointmentsQuery,
  SearchAppointmentsResponse,
  SearchAppointmentsQuery,
  DoctorsResponse,
  DoctorsQuery,
  DoctorDetail,
  DoctorTimeline,
  Certification,
  DoctorRatingsResponse,
  PatientsResponse,
  PatientsQuery,
  PatientDetail,
  PatientTimeline,
  PatientMedicalHistoryResponse,
  PatientRecordsResponse,
  PatientRecordsQuery,
  LabsResponse,
  LabsQuery,
  LabDetail,
  LabStaffResponse,
  LabDocument,
  PharmaciesResponse,
  PharmaciesQuery,
  PharmacyDetail,
  PharmacyStaffResponse,
  PharmacyDocument,
  FinanceStats,
  FinanceRevenueTrackingResponse,
  FinanceRevenueTrackingQuery,
  FinanceAppointmentsHistoryResponse,
  FinanceSubscriptionsHistoryResponse,
  FinanceSalesHistoryResponse,
  FinanceHistoryQuery,
  AnalyticsStats,
  AnalyticsDoctorsPercentage,
  AnalyticsPatientsStatistics,
  AnalyticsRevenueTrackingResponse,
  AnalyticsRevenueTrackingQuery,
  AnalyticsAppointmentsOverviewResponse,
  AnalyticsAppointmentsOverviewQuery,
  AnalyticsSalesAnalytics,
  AnalyticsDeliveryOverview,
  AnalyticsBillingMemberships,
  AnalyticsMonthQuery,
    AnalyticsYearQuery,
    VendorsResponse,
  VendorsQuery,
  VendorDetail,
  VendorDocument,
  VendorProductsResponse,
  VendorProductsQuery,
  VendorOrdersResponse,
  VendorOrdersQuery,
  VendorAnalyticsResponse,
  VendorPerformanceResponse,
  VendorStats,
  VendorYearQuery,
} from "@/types/healthnet.types";

const BASE = "/api/healthnet";

// ─── Dashboard ────────────────────────────────────────────────────────────────

export const fetchHealthnetMetrics = async (): Promise<HealthnetMetrics> => {
  const { data } = await api.get(`${BASE}/dashboard/metrics`);
  return data.data;
};

export const fetchActivityChart = async (month?: string): Promise<HealthnetActivityChart> => {
  const { data } = await api.get(`${BASE}/dashboard/charts/activity`, {
    params: month ? { month } : undefined,
  });
  return data.data;
};

export const fetchPatientsChart = async (month?: string): Promise<HealthnetPatientsChart> => {
  const { data } = await api.get(`${BASE}/dashboard/charts/patients`, {
    params: month ? { month } : undefined,
  });
  return data.data;
};

export const fetchRevenueChart = async (): Promise<HealthnetRevenueChart> => {
  const { data } = await api.get(`${BASE}/dashboard/charts/revenue`);
  return data.data;
};

// ─── Appointments ─────────────────────────────────────────────────────────────

export const fetchAppointments = async (
  query: AppointmentsQuery = {},
): Promise<AppointmentsResponse> => {
  const { data } = await api.get(`${BASE}/appointments`, { params: query });
  return data.data;
};

export const searchAppointments = async (
  query: SearchAppointmentsQuery,
): Promise<SearchAppointmentsResponse> => {
  const { data } = await api.get(`${BASE}/appointments/search`, { params: query });
  return data.data;
};

// ─── Doctors ──────────────────────────────────────────────────────────────────

export const fetchDoctors = async (query: DoctorsQuery = {}): Promise<DoctorsResponse> => {
  const { data } = await api.get(`${BASE}/doctors`, { params: query });
  return data.data;
};

export const fetchDoctorById = async (id: string): Promise<DoctorDetail> => {
  const { data } = await api.get(`${BASE}/doctors/${id}`);
  return data.data;
};

export const fetchDoctorAppointmentsTimeline = async (
  id: string,
  date?: string,
): Promise<DoctorTimeline> => {
  const { data } = await api.get(`${BASE}/doctors/${id}/appointments`, {
    params: date ? { date } : undefined,
  });
  return data.data;
};

export const fetchDoctorCertifications = async (id: string): Promise<Certification[]> => {
  const { data } = await api.get(`${BASE}/doctors/${id}/certifications`);
  return data.data;
};

export const fetchDoctorRatings = async (
  id: string,
  query: { page?: number; limit?: number } = {},
): Promise<DoctorRatingsResponse> => {
  const { data } = await api.get(`${BASE}/doctors/${id}/ratings`, { params: query });
  return data.data;
};

// ─── Patients ─────────────────────────────────────────────────────────────────

export const fetchPatients = async (query: PatientsQuery = {}): Promise<PatientsResponse> => {
  const { data } = await api.get(`${BASE}/patients`, { params: query });
  return data.data;
};

export const fetchPatientById = async (id: string): Promise<PatientDetail> => {
  const { data } = await api.get(`${BASE}/patients/${id}`);
  return data.data;
};

export const fetchPatientAppointmentsTimeline = async (
  id: string,
  date?: string,
): Promise<PatientTimeline> => {
  const { data } = await api.get(`${BASE}/patients/${id}/appointments`, {
    params: date ? { date } : undefined,
  });
  return data.data;
};

export const fetchPatientMedicalHistory = async (
  id: string,
  query: { page?: number; limit?: number } = {},
): Promise<PatientMedicalHistoryResponse> => {
  const { data } = await api.get(`${BASE}/patients/${id}/medical-history`, { params: query });
  return data.data;
};

export const fetchPatientRecords = async (
  id: string,
  query: PatientRecordsQuery = {},
): Promise<PatientRecordsResponse> => {
  const { data } = await api.get(`${BASE}/patients/${id}/records`, { params: query });
  return data.data;
};

// ─── Labs ─────────────────────────────────────────────────────────────────────

export const fetchLabs = async (query: LabsQuery = {}): Promise<LabsResponse> => {
  const { data } = await api.get(`${BASE}/labs`, { params: query });
  return data.data;
};

export const fetchLabById = async (id: string): Promise<LabDetail> => {
  const { data } = await api.get(`${BASE}/labs/${id}`);
  return data.data;
};

export const fetchLabStaff = async (id: string): Promise<LabStaffResponse> => {
  const { data } = await api.get(`${BASE}/labs/${id}/staff`);
  return data.data;
};

export const fetchLabDocuments = async (id: string): Promise<LabDocument[]> => {
  const { data } = await api.get(`${BASE}/labs/${id}/documents`);
  return data.data;
};

// ─── Pharmacies ───────────────────────────────────────────────────────────────

export const fetchPharmacies = async (query: PharmaciesQuery = {}): Promise<PharmaciesResponse> => {
  const { data } = await api.get(`${BASE}/pharmacies`, { params: query });
  return data.data;
};

export const fetchPharmacyById = async (id: string): Promise<PharmacyDetail> => {
  const { data } = await api.get(`${BASE}/pharmacies/${id}`);
  return data.data;
};

export const fetchPharmacyStaff = async (id: string): Promise<PharmacyStaffResponse> => {
  const { data } = await api.get(`${BASE}/pharmacies/${id}/staff`);
  return data.data;
};

export const fetchPharmacyDocuments = async (id: string): Promise<PharmacyDocument[]> => {
  const { data } = await api.get(`${BASE}/pharmacies/${id}/documents`);
  return data.data;
};

// ─── Finance ──────────────────────────────────────────────────────────────────

export const fetchFinanceStats = async (): Promise<FinanceStats> => {
  const { data } = await api.get(`${BASE}/finance/stats`);
  return data.data;
};

export const fetchFinanceRevenueTracking = async (
  query: FinanceRevenueTrackingQuery = {},
): Promise<FinanceRevenueTrackingResponse> => {
  const { data } = await api.get(`${BASE}/finance/revenue-tracking`, { params: query });
  return data.data;
};

export const fetchFinanceAppointmentsHistory = async (
  query: FinanceHistoryQuery = {},
): Promise<FinanceAppointmentsHistoryResponse> => {
  const { data } = await api.get(`${BASE}/finance/appointments-history`, { params: query });
  return data.data;
};

export const fetchFinanceSubscriptionsHistory = async (
  query: FinanceHistoryQuery = {},
): Promise<FinanceSubscriptionsHistoryResponse> => {
  const { data } = await api.get(`${BASE}/finance/subscriptions-history`, { params: query });
  return data.data;
};

export const fetchFinanceSalesHistory = async (
  query: FinanceHistoryQuery = {},
): Promise<FinanceSalesHistoryResponse> => {
  const { data } = await api.get(`${BASE}/finance/sales-history`, { params: query });
  return data.data;
};

// ─── Analytics ────────────────────────────────────────────────────────────────

export const fetchAnalyticsStats = async (): Promise<AnalyticsStats> => {
  const { data } = await api.get(`${BASE}/analytics/stats`);
  return data.data;
};

export const fetchAnalyticsDoctorsPercentage = async (
  query: AnalyticsMonthQuery = {},
): Promise<AnalyticsDoctorsPercentage> => {
  const { data } = await api.get(`${BASE}/analytics/doctors-percentage`, { params: query });
  return data.data;
};

export const fetchAnalyticsPatientsStatistics = async (
  query: AnalyticsMonthQuery = {},
): Promise<AnalyticsPatientsStatistics> => {
  const { data } = await api.get(`${BASE}/analytics/patients-statistics`, { params: query });
  return data.data;
};

export const fetchAnalyticsRevenueTracking = async (
  query: AnalyticsRevenueTrackingQuery = {},
): Promise<AnalyticsRevenueTrackingResponse> => {
  const { data } = await api.get(`${BASE}/analytics/revenue-tracking`, { params: query });
  return data.data;
};

export const fetchAnalyticsAppointmentsOverview = async (
  query: AnalyticsAppointmentsOverviewQuery = {},
): Promise<AnalyticsAppointmentsOverviewResponse> => {
  const { data } = await api.get(`${BASE}/analytics/appointments-overview`, { params: query });
  return data.data;
};

export const fetchAnalyticsSalesAnalytics = async (
  query: AnalyticsYearQuery = {},
): Promise<AnalyticsSalesAnalytics> => {
  const { data } = await api.get(`${BASE}/analytics/sales-analytics`, { params: query });
  return data.data;
};

export const fetchAnalyticsDeliveryOverview = async (
  query: AnalyticsYearQuery = {},
): Promise<AnalyticsDeliveryOverview> => {
  const { data } = await api.get(`${BASE}/analytics/delivery-overview`, { params: query });
  return data.data;
};

export const fetchAnalyticsBillingMemberships = async (
  query: AnalyticsMonthQuery = {},
): Promise<AnalyticsBillingMemberships> => {
  const { data } = await api.get(`${BASE}/analytics/billing-memberships`, { params: query });
  return data.data;
};

// ─── Vendors ──────────────────────────────────────────────────────────────────

export const fetchVendors = async (
  query: VendorsQuery = {},
): Promise<VendorsResponse> => {
  const { data } = await api.get(`${BASE}/vendors`, { params: query });
  return data.data;
};

export const fetchVendorById = async (id: string): Promise<VendorDetail> => {
  const { data } = await api.get(`${BASE}/vendors/${id}`);
  return data.data;
};

export const fetchVendorDocuments = async (id: string): Promise<VendorDocument[]> => {
  const { data } = await api.get(`${BASE}/vendors/${id}/documents`);
  return data.data;
};

export const fetchVendorProducts = async (
  id: string,
  query: VendorProductsQuery = {},
): Promise<VendorProductsResponse> => {
  const { data } = await api.get(`${BASE}/vendors/${id}/products`, { params: query });
  return data.data;
};

export const fetchVendorOrders = async (
  id: string,
  query: VendorOrdersQuery = {},
): Promise<VendorOrdersResponse> => {
  const { data } = await api.get(`${BASE}/vendors/${id}/orders`, { params: query });
  return data.data;
};

export const fetchVendorAnalytics = async (
  id: string,
  query: VendorYearQuery = {},
): Promise<VendorAnalyticsResponse> => {
  const { data } = await api.get(`${BASE}/vendors/${id}/analytics`, { params: query });
  return data.data;
};

export const fetchVendorPerformance = async (
  id: string,
  query: VendorYearQuery = {},
): Promise<VendorPerformanceResponse> => {
  const { data } = await api.get(`${BASE}/vendors/${id}/performance`, { params: query });
  return data.data;
};

export const fetchVendorStats = async (id: string): Promise<VendorStats> => {
  const { data } = await api.get(`${BASE}/vendors/${id}/stats`);
  return data.data;
};