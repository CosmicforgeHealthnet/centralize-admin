import { create, type StoreApi } from "zustand";
import { describeServiceError } from "@/lib/service-errors";
import {
  fetchHealthnetMetrics,
  fetchActivityChart,
  fetchPatientsChart,
  fetchRevenueChart,
  fetchAppointments,
  searchAppointments,
  fetchDoctors,
  fetchDoctorById,
  fetchDoctorAppointmentsTimeline,
  fetchDoctorCertifications,
  fetchDoctorRatings,
  fetchPatients,
  fetchPatientById,
  fetchPatientAppointmentsTimeline,
  fetchPatientMedicalHistory,
  fetchPatientRecords,
  fetchLabs,
  fetchLabById,
  fetchLabStaff,
  fetchLabDocuments,
  fetchPharmacies,
  fetchPharmacyById,
  fetchPharmacyStaff,
  fetchPharmacyDocuments,
  fetchFinanceStats,
  fetchFinanceRevenueTracking,
  fetchFinanceAppointmentsHistory,
  fetchFinanceSubscriptionsHistory,
  fetchFinanceSalesHistory,
  fetchAnalyticsStats,
  fetchAnalyticsDoctorsPercentage,
  fetchAnalyticsPatientsStatistics,
  fetchAnalyticsRevenueTracking,
  fetchAnalyticsAppointmentsOverview,
  fetchAnalyticsSalesAnalytics,
  fetchAnalyticsDeliveryOverview,
    fetchAnalyticsBillingMemberships,
    fetchVendors,
  fetchVendorById,
  fetchVendorDocuments,
  fetchVendorProducts,
  fetchVendorOrders,
  fetchVendorAnalytics,
  fetchVendorPerformance,
  fetchVendorStats,
} from "@/lib/healthnet.service";
import type {
  HealthnetMetrics,
  HealthnetActivityChart,
  HealthnetPatientsChart,
  HealthnetRevenueChart,
  AppointmentsResponse,
  SearchAppointmentsResponse,
  AppointmentsQuery,
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

interface HealthnetState {
  // ── metrics ────────────────────────────────────────────────────────────────
  metrics: HealthnetMetrics | null;
  metricsLoading: boolean;
  metricsError: string | null;
  fetchMetrics: () => Promise<void>;

  // ── activity chart ─────────────────────────────────────────────────────────
  activityChart: HealthnetActivityChart | null;
  activityChartLoading: boolean;
  activityChartError: string | null;
  fetchActivityChart: (month?: string) => Promise<void>;

  // ── patients chart ─────────────────────────────────────────────────────────
  patientsChart: HealthnetPatientsChart | null;
  patientsChartLoading: boolean;
  patientsChartError: string | null;
  fetchPatientsChart: (month?: string) => Promise<void>;

  // ── revenue chart ──────────────────────────────────────────────────────────
  revenueChart: HealthnetRevenueChart | null;
  revenueChartLoading: boolean;
  revenueChartError: string | null;
  fetchRevenueChart: () => Promise<void>;

  // ── appointments ───────────────────────────────────────────────────────────
  appointments: AppointmentsResponse | null;
  appointmentsLoading: boolean;
  appointmentsError: string | null;
  fetchAppointments: (query?: AppointmentsQuery) => Promise<void>;

  // ── search ─────────────────────────────────────────────────────────────────
  searchResults: SearchAppointmentsResponse | null;
  searchLoading: boolean;
  searchError: string | null;
  searchAppointments: (query: SearchAppointmentsQuery) => Promise<void>;
  clearSearch: () => void;

  // ── doctors list ───────────────────────────────────────────────────────────
  doctors: DoctorsResponse | null;
  doctorsLoading: boolean;
  doctorsError: string | null;
  fetchDoctors: (query?: DoctorsQuery) => Promise<void>;

  // ── doctor detail ──────────────────────────────────────────────────────────
  doctorDetail: DoctorDetail | null;
  doctorDetailLoading: boolean;
  doctorDetailError: string | null;
  fetchDoctorById: (id: string) => Promise<void>;

  // ── doctor timeline ────────────────────────────────────────────────────────
  doctorTimeline: DoctorTimeline | null;
  doctorTimelineLoading: boolean;
  doctorTimelineError: string | null;
  fetchDoctorTimeline: (id: string, date?: string) => Promise<void>;

  // ── doctor certifications ──────────────────────────────────────────────────
  doctorCertifications: Certification[];
  doctorCertificationsLoading: boolean;
  doctorCertificationsError: string | null;
  fetchDoctorCertifications: (id: string) => Promise<void>;

  // ── doctor ratings ─────────────────────────────────────────────────────────
  doctorRatings: DoctorRatingsResponse | null;
  doctorRatingsLoading: boolean;
  doctorRatingsError: string | null;
  fetchDoctorRatings: (id: string, query?: { page?: number; limit?: number }) => Promise<void>;

  // ── patients list ──────────────────────────────────────────────────────────
  patients: PatientsResponse | null;
  patientsLoading: boolean;
  patientsError: string | null;
  fetchPatients: (query?: PatientsQuery) => Promise<void>;

  // ── patient detail ─────────────────────────────────────────────────────────
  patientDetail: PatientDetail | null;
  patientDetailLoading: boolean;
  patientDetailError: string | null;
  fetchPatientById: (id: string) => Promise<void>;

  // ── patient timeline ───────────────────────────────────────────────────────
  patientTimeline: PatientTimeline | null;
  patientTimelineLoading: boolean;
  patientTimelineError: string | null;
  fetchPatientTimeline: (id: string, date?: string) => Promise<void>;

  // ── patient medical history ────────────────────────────────────────────────
  patientMedicalHistory: PatientMedicalHistoryResponse | null;
  patientMedicalHistoryLoading: boolean;
  patientMedicalHistoryError: string | null;
  fetchPatientMedicalHistory: (id: string, query?: { page?: number; limit?: number }) => Promise<void>;

  // ── patient records ────────────────────────────────────────────────────────
  patientRecords: PatientRecordsResponse | null;
  patientRecordsLoading: boolean;
  patientRecordsError: string | null;
  fetchPatientRecords: (id: string, query?: PatientRecordsQuery) => Promise<void>;

  // ── labs list ─────────────────────────────────────────────────────────────
  labs: LabsResponse | null;
  labsLoading: boolean;
  labsError: string | null;
  fetchLabs: (query?: LabsQuery) => Promise<void>;

  // ── lab detail ────────────────────────────────────────────────────────────
  labDetail: LabDetail | null;
  labDetailLoading: boolean;
  labDetailError: string | null;
  fetchLabById: (id: string) => Promise<void>;

  // ── lab staff ─────────────────────────────────────────────────────────────
  labStaff: LabStaffResponse | null;
  labStaffLoading: boolean;
  labStaffError: string | null;
  fetchLabStaff: (id: string) => Promise<void>;

  // ── lab documents ─────────────────────────────────────────────────────────
  labDocuments: LabDocument[];
  labDocumentsLoading: boolean;
  labDocumentsError: string | null;
  fetchLabDocuments: (id: string) => Promise<void>;

  // ── pharmacies list ───────────────────────────────────────────────────────
  pharmacies: PharmaciesResponse | null;
  pharmaciesLoading: boolean;
  pharmaciesError: string | null;
  fetchPharmacies: (query?: PharmaciesQuery) => Promise<void>;

  // ── pharmacy detail ───────────────────────────────────────────────────────
  pharmacyDetail: PharmacyDetail | null;
  pharmacyDetailLoading: boolean;
  pharmacyDetailError: string | null;
  fetchPharmacyById: (id: string) => Promise<void>;

  // ── pharmacy staff ────────────────────────────────────────────────────────
  pharmacyStaff: PharmacyStaffResponse | null;
  pharmacyStaffLoading: boolean;
  pharmacyStaffError: string | null;
  fetchPharmacyStaff: (id: string) => Promise<void>;

  // ── pharmacy documents ────────────────────────────────────────────────────
  pharmacyDocuments: PharmacyDocument[];
  pharmacyDocumentsLoading: boolean;
  pharmacyDocumentsError: string | null;
  fetchPharmacyDocuments: (id: string) => Promise<void>;

  // ── finance stats ─────────────────────────────────────────────────────────
  financeStats: FinanceStats | null;
  financeStatsLoading: boolean;
  financeStatsError: string | null;
  fetchFinanceStats: () => Promise<void>;

  // ── finance revenue tracking ──────────────────────────────────────────────
  financeRevenueTracking: FinanceRevenueTrackingResponse | null;
  financeRevenueTrackingLoading: boolean;
  financeRevenueTrackingError: string | null;
  fetchFinanceRevenueTracking: (query?: FinanceRevenueTrackingQuery) => Promise<void>;

  // ── finance appointments history ──────────────────────────────────────────
  financeAppointmentsHistory: FinanceAppointmentsHistoryResponse | null;
  financeAppointmentsHistoryLoading: boolean;
  financeAppointmentsHistoryError: string | null;
  fetchFinanceAppointmentsHistory: (query?: FinanceHistoryQuery) => Promise<void>;

  // ── finance subscriptions history ─────────────────────────────────────────
  financeSubscriptionsHistory: FinanceSubscriptionsHistoryResponse | null;
  financeSubscriptionsHistoryLoading: boolean;
  financeSubscriptionsHistoryError: string | null;
  fetchFinanceSubscriptionsHistory: (query?: FinanceHistoryQuery) => Promise<void>;

  // ── finance sales history ─────────────────────────────────────────────────
  financeSalesHistory: FinanceSalesHistoryResponse | null;
  financeSalesHistoryLoading: boolean;
  financeSalesHistoryError: string | null;
  fetchFinanceSalesHistory: (query?: FinanceHistoryQuery) => Promise<void>;

  // ── analytics stats ───────────────────────────────────────────────────────
  analyticsStats: AnalyticsStats | null;
  analyticsStatsLoading: boolean;
  analyticsStatsError: string | null;
  fetchAnalyticsStats: () => Promise<void>;

  // ── analytics doctors percentage ──────────────────────────────────────────
  analyticsDoctorsPercentage: AnalyticsDoctorsPercentage | null;
  analyticsDoctorsPercentageLoading: boolean;
  analyticsDoctorsPercentageError: string | null;
  fetchAnalyticsDoctorsPercentage: (query?: AnalyticsMonthQuery) => Promise<void>;

  // ── analytics patients statistics ─────────────────────────────────────────
  analyticsPatientsStatistics: AnalyticsPatientsStatistics | null;
  analyticsPatientsStatisticsLoading: boolean;
  analyticsPatientsStatisticsError: string | null;
  fetchAnalyticsPatientsStatistics: (query?: AnalyticsMonthQuery) => Promise<void>;

  // ── analytics revenue tracking ────────────────────────────────────────────
  analyticsRevenueTracking: AnalyticsRevenueTrackingResponse | null;
  analyticsRevenueTrackingLoading: boolean;
  analyticsRevenueTrackingError: string | null;
  fetchAnalyticsRevenueTracking: (query?: AnalyticsRevenueTrackingQuery) => Promise<void>;

  // ── analytics appointments overview ──────────────────────────────────────
  analyticsAppointmentsOverview: AnalyticsAppointmentsOverviewResponse | null;
  analyticsAppointmentsOverviewLoading: boolean;
  analyticsAppointmentsOverviewError: string | null;
  fetchAnalyticsAppointmentsOverview: (query?: AnalyticsAppointmentsOverviewQuery) => Promise<void>;

  // ── analytics sales analytics ─────────────────────────────────────────────
  analyticsSalesAnalytics: AnalyticsSalesAnalytics | null;
  analyticsSalesAnalyticsLoading: boolean;
  analyticsSalesAnalyticsError: string | null;
  fetchAnalyticsSalesAnalytics: (query?: AnalyticsYearQuery) => Promise<void>;

  // ── analytics delivery overview ───────────────────────────────────────────
  analyticsDeliveryOverview: AnalyticsDeliveryOverview | null;
  analyticsDeliveryOverviewLoading: boolean;
  analyticsDeliveryOverviewError: string | null;
  fetchAnalyticsDeliveryOverview: (query?: AnalyticsYearQuery) => Promise<void>;

  // ── analytics billing memberships ─────────────────────────────────────────
  analyticsBillingMemberships: AnalyticsBillingMemberships | null;
  analyticsBillingMembershipsLoading: boolean;
  analyticsBillingMembershipsError: string | null;
    fetchAnalyticsBillingMemberships: (query?: AnalyticsMonthQuery) => Promise<void>;
    // ── vendors list ──────────────────────────────────────────────────────────
  vendors: VendorsResponse | null;
  vendorsLoading: boolean;
  vendorsError: string | null;
  fetchVendors: (query?: VendorsQuery) => Promise<void>;

  // ── vendor detail ─────────────────────────────────────────────────────────
  vendorDetail: VendorDetail | null;
  vendorDetailLoading: boolean;
  vendorDetailError: string | null;
  fetchVendorById: (id: string) => Promise<void>;

  // ── vendor documents ──────────────────────────────────────────────────────
  vendorDocuments: VendorDocument[];
  vendorDocumentsLoading: boolean;
  vendorDocumentsError: string | null;
  fetchVendorDocuments: (id: string) => Promise<void>;

  // ── vendor products ───────────────────────────────────────────────────────
  vendorProducts: VendorProductsResponse | null;
  vendorProductsLoading: boolean;
  vendorProductsError: string | null;
  fetchVendorProducts: (id: string, query?: VendorProductsQuery) => Promise<void>;

  // ── vendor orders ─────────────────────────────────────────────────────────
  vendorOrders: VendorOrdersResponse | null;
  vendorOrdersLoading: boolean;
  vendorOrdersError: string | null;
  fetchVendorOrders: (id: string, query?: VendorOrdersQuery) => Promise<void>;

  // ── vendor analytics ──────────────────────────────────────────────────────
  vendorAnalytics: VendorAnalyticsResponse | null;
  vendorAnalyticsLoading: boolean;
  vendorAnalyticsError: string | null;
  fetchVendorAnalytics: (id: string, query?: VendorYearQuery) => Promise<void>;

  // ── vendor performance ────────────────────────────────────────────────────
  vendorPerformance: VendorPerformanceResponse | null;
  vendorPerformanceLoading: boolean;
  vendorPerformanceError: string | null;
  fetchVendorPerformance: (id: string, query?: VendorYearQuery) => Promise<void>;

  // ── vendor stats ──────────────────────────────────────────────────────────
  vendorStats: VendorStats | null;
  vendorStatsLoading: boolean;
  vendorStatsError: string | null;
  fetchVendorStats: (id: string) => Promise<void>;
}

function makeSlice<TArgs extends unknown[], T>(
  key: string,
  fetcher: (...args: TArgs) => Promise<T>,
  set: StoreApi<HealthnetState>["setState"],
) {
  return async (...args: TArgs) => {
    set(() => ({ [`${key}Loading`]: true, [`${key}Error`]: null } as Partial<HealthnetState>));
    try {
      const result = await fetcher(...args);
      set(() => ({ [key]: result, [`${key}Loading`]: false } as Partial<HealthnetState>));
    } catch (err) {
      set(() => ({
        [`${key}Error`]: describeServiceError(err, "HealthNet"),
        [`${key}Loading`]: false,
      } as Partial<HealthnetState>));
    }
  };
}

export const useHealthnetStore = create<HealthnetState>((set) => ({
  // ── metrics ────────────────────────────────────────────────────────────────
  metrics: null, metricsLoading: false, metricsError: null,
  fetchMetrics: makeSlice("metrics", fetchHealthnetMetrics, set),

  // ── activity chart ─────────────────────────────────────────────────────────
  activityChart: null, activityChartLoading: false, activityChartError: null,
  fetchActivityChart: makeSlice("activityChart", fetchActivityChart, set),

  // ── patients chart ─────────────────────────────────────────────────────────
  patientsChart: null, patientsChartLoading: false, patientsChartError: null,
  fetchPatientsChart: makeSlice("patientsChart", fetchPatientsChart, set),

  // ── revenue chart ──────────────────────────────────────────────────────────
  revenueChart: null, revenueChartLoading: false, revenueChartError: null,
  fetchRevenueChart: makeSlice("revenueChart", fetchRevenueChart, set),

  // ── appointments ───────────────────────────────────────────────────────────
  appointments: null, appointmentsLoading: false, appointmentsError: null,
  fetchAppointments: makeSlice("appointments", fetchAppointments, set),

  // ── search ─────────────────────────────────────────────────────────────────
  searchResults: null, searchLoading: false, searchError: null,
  searchAppointments: makeSlice("search", searchAppointments, set),
  clearSearch: () => set({ searchResults: null, searchError: null }),

  // ── doctors list ───────────────────────────────────────────────────────────
  doctors: null, doctorsLoading: false, doctorsError: null,
  fetchDoctors: makeSlice("doctors", fetchDoctors, set),

  // ── doctor detail ──────────────────────────────────────────────────────────
  doctorDetail: null, doctorDetailLoading: false, doctorDetailError: null,
  fetchDoctorById: makeSlice("doctorDetail", fetchDoctorById, set),

  // ── doctor timeline ────────────────────────────────────────────────────────
  doctorTimeline: null, doctorTimelineLoading: false, doctorTimelineError: null,
  fetchDoctorTimeline: makeSlice("doctorTimeline", fetchDoctorAppointmentsTimeline, set),

  // ── doctor certifications ──────────────────────────────────────────────────
  doctorCertifications: [], doctorCertificationsLoading: false, doctorCertificationsError: null,
  fetchDoctorCertifications: makeSlice("doctorCertifications", fetchDoctorCertifications, set),

  // ── doctor ratings ─────────────────────────────────────────────────────────
  doctorRatings: null, doctorRatingsLoading: false, doctorRatingsError: null,
  fetchDoctorRatings: makeSlice("doctorRatings", fetchDoctorRatings, set),

  // ── patients list ──────────────────────────────────────────────────────────
  patients: null, patientsLoading: false, patientsError: null,
  fetchPatients: makeSlice("patients", fetchPatients, set),

  // ── patient detail ─────────────────────────────────────────────────────────
  patientDetail: null, patientDetailLoading: false, patientDetailError: null,
  fetchPatientById: makeSlice("patientDetail", fetchPatientById, set),

  // ── patient timeline ───────────────────────────────────────────────────────
  patientTimeline: null, patientTimelineLoading: false, patientTimelineError: null,
  fetchPatientTimeline: makeSlice("patientTimeline", fetchPatientAppointmentsTimeline, set),

  // ── patient medical history ────────────────────────────────────────────────
  patientMedicalHistory: null, patientMedicalHistoryLoading: false, patientMedicalHistoryError: null,
  fetchPatientMedicalHistory: makeSlice("patientMedicalHistory", fetchPatientMedicalHistory, set),

  // ── patient records ────────────────────────────────────────────────────────
  patientRecords: null, patientRecordsLoading: false, patientRecordsError: null,
  fetchPatientRecords: makeSlice("patientRecords", fetchPatientRecords, set),

  // ── labs list ─────────────────────────────────────────────────────────────
  labs: null, labsLoading: false, labsError: null,
  fetchLabs: makeSlice("labs", fetchLabs, set),

  // ── lab detail ────────────────────────────────────────────────────────────
  labDetail: null, labDetailLoading: false, labDetailError: null,
  fetchLabById: makeSlice("labDetail", fetchLabById, set),

  // ── lab staff ─────────────────────────────────────────────────────────────
  labStaff: null, labStaffLoading: false, labStaffError: null,
  fetchLabStaff: makeSlice("labStaff", fetchLabStaff, set),

  // ── lab documents ─────────────────────────────────────────────────────────
  labDocuments: [], labDocumentsLoading: false, labDocumentsError: null,
  fetchLabDocuments: makeSlice("labDocuments", fetchLabDocuments, set),

  // ── pharmacies list ───────────────────────────────────────────────────────
  pharmacies: null, pharmaciesLoading: false, pharmaciesError: null,
  fetchPharmacies: makeSlice("pharmacies", fetchPharmacies, set),

  // ── pharmacy detail ───────────────────────────────────────────────────────
  pharmacyDetail: null, pharmacyDetailLoading: false, pharmacyDetailError: null,
  fetchPharmacyById: makeSlice("pharmacyDetail", fetchPharmacyById, set),

  // ── pharmacy staff ────────────────────────────────────────────────────────
  pharmacyStaff: null, pharmacyStaffLoading: false, pharmacyStaffError: null,
  fetchPharmacyStaff: makeSlice("pharmacyStaff", fetchPharmacyStaff, set),

  // ── pharmacy documents ────────────────────────────────────────────────────
  pharmacyDocuments: [], pharmacyDocumentsLoading: false, pharmacyDocumentsError: null,
  fetchPharmacyDocuments: makeSlice("pharmacyDocuments", fetchPharmacyDocuments, set),

  // ── finance stats ─────────────────────────────────────────────────────────
  financeStats: null, financeStatsLoading: false, financeStatsError: null,
  fetchFinanceStats: makeSlice("financeStats", fetchFinanceStats, set),

  // ── finance revenue tracking ──────────────────────────────────────────────
  financeRevenueTracking: null, financeRevenueTrackingLoading: false, financeRevenueTrackingError: null,
  fetchFinanceRevenueTracking: makeSlice("financeRevenueTracking", fetchFinanceRevenueTracking, set),

  // ── finance appointments history ──────────────────────────────────────────
  financeAppointmentsHistory: null, financeAppointmentsHistoryLoading: false, financeAppointmentsHistoryError: null,
  fetchFinanceAppointmentsHistory: makeSlice("financeAppointmentsHistory", fetchFinanceAppointmentsHistory, set),

  // ── finance subscriptions history ─────────────────────────────────────────
  financeSubscriptionsHistory: null, financeSubscriptionsHistoryLoading: false, financeSubscriptionsHistoryError: null,
  fetchFinanceSubscriptionsHistory: makeSlice("financeSubscriptionsHistory", fetchFinanceSubscriptionsHistory, set),

  // ── finance sales history ─────────────────────────────────────────────────
  financeSalesHistory: null, financeSalesHistoryLoading: false, financeSalesHistoryError: null,
  fetchFinanceSalesHistory: makeSlice("financeSalesHistory", fetchFinanceSalesHistory, set),

  // ── analytics stats ───────────────────────────────────────────────────────
  analyticsStats: null, analyticsStatsLoading: false, analyticsStatsError: null,
  fetchAnalyticsStats: makeSlice("analyticsStats", fetchAnalyticsStats, set),

  // ── analytics doctors percentage ──────────────────────────────────────────
  analyticsDoctorsPercentage: null, analyticsDoctorsPercentageLoading: false, analyticsDoctorsPercentageError: null,
  fetchAnalyticsDoctorsPercentage: makeSlice("analyticsDoctorsPercentage", fetchAnalyticsDoctorsPercentage, set),

  // ── analytics patients statistics ─────────────────────────────────────────
  analyticsPatientsStatistics: null, analyticsPatientsStatisticsLoading: false, analyticsPatientsStatisticsError: null,
  fetchAnalyticsPatientsStatistics: makeSlice("analyticsPatientsStatistics", fetchAnalyticsPatientsStatistics, set),

  // ── analytics revenue tracking ────────────────────────────────────────────
  analyticsRevenueTracking: null, analyticsRevenueTrackingLoading: false, analyticsRevenueTrackingError: null,
  fetchAnalyticsRevenueTracking: makeSlice("analyticsRevenueTracking", fetchAnalyticsRevenueTracking, set),

  // ── analytics appointments overview ──────────────────────────────────────
  analyticsAppointmentsOverview: null, analyticsAppointmentsOverviewLoading: false, analyticsAppointmentsOverviewError: null,
  fetchAnalyticsAppointmentsOverview: makeSlice("analyticsAppointmentsOverview", fetchAnalyticsAppointmentsOverview, set),

  // ── analytics sales analytics ─────────────────────────────────────────────
  analyticsSalesAnalytics: null, analyticsSalesAnalyticsLoading: false, analyticsSalesAnalyticsError: null,
  fetchAnalyticsSalesAnalytics: makeSlice("analyticsSalesAnalytics", fetchAnalyticsSalesAnalytics, set),

  // ── analytics delivery overview ───────────────────────────────────────────
  analyticsDeliveryOverview: null, analyticsDeliveryOverviewLoading: false, analyticsDeliveryOverviewError: null,
  fetchAnalyticsDeliveryOverview: makeSlice("analyticsDeliveryOverview", fetchAnalyticsDeliveryOverview, set),

  // ── analytics billing memberships ─────────────────────────────────────────
  analyticsBillingMemberships: null, analyticsBillingMembershipsLoading: false, analyticsBillingMembershipsError: null,
    fetchAnalyticsBillingMemberships: makeSlice("analyticsBillingMemberships", fetchAnalyticsBillingMemberships, set),
  // ── vendors list ──────────────────────────────────────────────────────────
  vendors: null, vendorsLoading: false, vendorsError: null,
  fetchVendors: makeSlice("vendors", fetchVendors, set),

  // ── vendor detail ─────────────────────────────────────────────────────────
  vendorDetail: null, vendorDetailLoading: false, vendorDetailError: null,
  fetchVendorById: makeSlice("vendorDetail", fetchVendorById, set),

  // ── vendor documents ──────────────────────────────────────────────────────
  vendorDocuments: [], vendorDocumentsLoading: false, vendorDocumentsError: null,
  fetchVendorDocuments: makeSlice("vendorDocuments", fetchVendorDocuments, set),

  // ── vendor products ───────────────────────────────────────────────────────
  vendorProducts: null, vendorProductsLoading: false, vendorProductsError: null,
  fetchVendorProducts: makeSlice("vendorProducts", fetchVendorProducts, set),

  // ── vendor orders ─────────────────────────────────────────────────────────
  vendorOrders: null, vendorOrdersLoading: false, vendorOrdersError: null,
  fetchVendorOrders: makeSlice("vendorOrders", fetchVendorOrders, set),

  // ── vendor analytics ──────────────────────────────────────────────────────
  vendorAnalytics: null, vendorAnalyticsLoading: false, vendorAnalyticsError: null,
  fetchVendorAnalytics: makeSlice("vendorAnalytics", fetchVendorAnalytics, set),

  // ── vendor performance ────────────────────────────────────────────────────
  vendorPerformance: null, vendorPerformanceLoading: false, vendorPerformanceError: null,
  fetchVendorPerformance: makeSlice("vendorPerformance", fetchVendorPerformance, set),

  // ── vendor stats ──────────────────────────────────────────────────────────
  vendorStats: null, vendorStatsLoading: false, vendorStatsError: null,
  fetchVendorStats: makeSlice("vendorStats", fetchVendorStats, set),
}));