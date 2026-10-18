// ─── Dashboard Metrics ───────────────────────────────────────────────────────

export interface HealthnetMetrics {
  totalAppointments: number;
  totalDoctors: number;
  totalPatients: number;
  balance: number;
}

// ─── Activity Chart ───────────────────────────────────────────────────────────

export interface HealthnetActivityChart {
  month: string;
  totalDoctors: number;
  newDoctors: number;
  appointments: number;
  productPurchase: number;
}

// ─── Patients Chart ───────────────────────────────────────────────────────────

export interface PatientsChartDataPoint {
  month: string;
  value: number;
}

export interface HealthnetPatientsChart {
  selectedMonth: string;
  data: PatientsChartDataPoint[];
}

// ─── Revenue Chart ────────────────────────────────────────────────────────────

export interface RevenueChartDataPoint {
  month: string;
  incomeUsd: number;
  incomeNgn: number;
  expenseUsd: number;
  expenseNgn: number;
}

export interface HealthnetRevenueChart {
  data: RevenueChartDataPoint[];
}

// ─── Appointments ─────────────────────────────────────────────────────────────

export type AppointmentStatus = "upcoming" | "past" | "cancelled";
export type AppointmentColor = "pink" | "green" | "solid-blue" | "yellow";

export interface AppointmentCard {
  id: string;
  patient: string;
  time: string;
  timeEnd: string;
  count: string;
  color: AppointmentColor;
  status: AppointmentStatus;
}

export interface DoctorAppointmentGroup {
  id: string;
  name: string;
  specialty: string;
  initials: string;
  avatarBg: string;
  percentage: number;
  percentageColor: string;
  appointments: AppointmentCard[];
}

export interface AppointmentDateGroup {
  date: string;
  doctors: DoctorAppointmentGroup[];
}

export interface AppointmentsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AppointmentsResponse {
  appointments: AppointmentDateGroup[];
  pagination: AppointmentsPagination;
}

export interface AppointmentsQuery {
  page?: number;
  limit?: number;
  date?: string;
  year?: number;
  month?: number;
  status?: string;
  department?: string;
}

export interface SearchAppointmentsResponse {
  query: string;
  total: number;
  results: AppointmentDateGroup[];
  pagination: AppointmentsPagination;
}

export interface SearchAppointmentsQuery {
  q: string;
  page?: number;
  limit?: number;
  department?: string;
  category?: string;
}

// ─── Doctors List ─────────────────────────────────────────────────────────────

export interface DoctorRow {
  id: string;
  name: string;
  department: string | null;
  email: string;
  phone: string | null;
  patients: number;
  experience: number;
  rating: number;
  status: string;
  joiningDate: string | null;
  avatarUrl: string | null;
}

export interface DoctorsResponse {
  total: number;
  page: number;
  limit: number;
  doctors: DoctorRow[];
}

export interface DoctorsQuery {
  page?: number;
  limit?: number;
  search?: string;
  department?: string;
  status?: string;
}

// ─── Doctor Detail ────────────────────────────────────────────────────────────

export interface DoctorDetail {
  id: string;
  name: string;
  hospital: string | null;
  email: string;
  phone: string | null;
  department: string | null;
  specialty: string | null;
  patients: number;
  experience: number;
  rating: number;
  location: string | null;
  address: string | null;
  bio: string | null;
  workingDays: string[];
  workingHours: string | null;
  avatarUrl: string | null;
}

// ─── Doctor Timeline ──────────────────────────────────────────────────────────

export interface TimelineAppointment {
  id: string;
  patientName: string | null;
  specialty: string | null;
  date: string | null;
  time: string | null;
  slotIndex: number | null;
  index: number;
  total: number;
}

export interface DoctorTimeline {
  date: string | null;
  upcoming: TimelineAppointment[];
  past: TimelineAppointment[];
  cancelled: TimelineAppointment[];
}

// ─── Doctor Certifications ────────────────────────────────────────────────────

export interface Certification {
  id: string;
  index: number;
  title: string | null;
  licenseNumber: string | null;
  expiryDate: string | null;
  imageUrl: string | null;
}

// ─── Doctor Ratings ───────────────────────────────────────────────────────────

export interface DoctorRating {
  id: string;
  reviewerName: string | null;
  stars: number;
  comment: string | null;
  timeAgo: string | null;
  avatar: string | null;
}

export interface DoctorRatingsResponse {
  total: number;
  page: number;
  limit: number;
  ratings: DoctorRating[];
}

// ─── Patients List ────────────────────────────────────────────────────────────

export interface PatientRow {
  id: string;
  name: string;
  profileType: string | null;
  email: string;
  phone: string | null;
  joiningDate: string | null;
  avatarUrl: string | null;
}

export interface PatientsResponse {
  total: number;
  page: number;
  limit: number;
  patients: PatientRow[];
}

export interface PatientsQuery {
  page?: number;
  limit?: number;
  search?: string;
  profileType?: string;
}

// ─── Patient Detail ───────────────────────────────────────────────────────────

export interface PatientDetail {
  id: string;
  name: string;
  email: string;
  location: string | null;
  profileType: string | null;
  sex: string | null;
  age: number | null;
  bloodGroup: string | null;
  genotype: string | null;
  height: string | null;
  weight: string | null;
  allergies: string[];
  homeAddress: string | null;
  workAddress: string | null;
  avatarUrl: string | null;
}

// ─── Patient Timeline ─────────────────────────────────────────────────────────

export interface PatientTimelineAppointment {
  id: string;
  doctorName: string | null;
  specialty: string | null;
  date: string | null;
  time: string | null;
  slotIndex: number | null;
  index: number;
  total: number;
}

export interface PatientTimeline {
  date: string | null;
  upcoming: PatientTimelineAppointment[];
  past: PatientTimelineAppointment[];
  cancelled: PatientTimelineAppointment[];
}

// ─── Patient Medical History ──────────────────────────────────────────────────

export interface MedicalHistoryItem {
  id: string;
  date: string | null;
  type: string;
  title: string | null;
  doctor: string | null;
  department: string | null;
  notes: string | null;
  attachments: unknown[];
}

export interface PatientMedicalHistoryResponse {
  total: number;
  page: number;
  limit: number;
  history: MedicalHistoryItem[];
}

// ─── Patient Records ──────────────────────────────────────────────────────────

export type RecordType = "lab" | "imaging" | "prescription" | "referral" | "other" | "all";

export interface PatientRecord {
  id: string;
  type: Exclude<RecordType, "all">;
  title: string | null;
  uploadedBy: string | null;
  uploadedAt: string | null;
  fileUrl: string | null;
  fileType: string | null;
  fileSizeKb: number | null;
}

export interface PatientRecordsResponse {
  total: number;
  page: number;
  limit: number;
  records: PatientRecord[];
}

export interface PatientRecordsQuery {
  type?: RecordType;
  page?: number;
  limit?: number;
}

// ─── Labs ─────────────────────────────────────────────────────────────────────

export interface LabRow {
  id: string;
  name: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  joiningDate: string | null;
  avatarUrl: string | null;
}

export interface LabsResponse {
  total: number;
  page: number;
  limit: number;
  labs: LabRow[];
}

export interface LabsQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export interface LabDetail {
  id: string;
  businessName: string | null;
  registrationNumber: string | null;
  businessAddress: string | null;
  labWebsite: string | null;
  hours: string | null;
  deliveryCapacity: boolean;
  staffCount: number;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  location: string | null;
  registrationDate: string | null;
  status: string;
  avatarUrl: string | null;
}

export interface LabStaffMember {
  id: string;
  name: string | null;
  experience: string | null;
  phone: string | null;
  avatarUrl: string | null;
}

export interface LabStaffGroup {
  role: string;
  members: LabStaffMember[];
}

export interface LabStaffResponse {
  staffCount: number;
  groups: LabStaffGroup[];
}

export interface LabDocument {
  id: string;
  type: string;
  label: string;
  fileUrl: string | null;
  fileType: string | null;
  fileSizeMb: number | null;
}

// ─── Pharmacies ───────────────────────────────────────────────────────────────

export interface PharmacyRow {
  id: string;
  name: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  joiningDate: string | null;
  avatarUrl: string | null;
}

export interface PharmaciesResponse {
  total: number;
  page: number;
  limit: number;
  pharmacies: PharmacyRow[];
}

export interface PharmaciesQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export interface PharmacyDetail {
  id: string;
  businessName: string | null;
  registrationNumber: string | null;
  businessAddress: string | null;
  pharmacyWebsite: string | null;
  hours: string | null;
  deliveryCapacity: boolean;
  staffCount: number;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  location: string | null;
  registrationDate: string | null;
  status: string;
  avatarUrl: string | null;
}

export interface PharmacyStaffMember {
  id: string;
  name: string | null;
  experience: string | null;
  phone: string | null;
  avatarUrl: string | null;
}

export interface PharmacyStaffGroup {
  role: string;
  members: PharmacyStaffMember[];
}

export interface PharmacyStaffResponse {
  staffCount: number;
  groups: PharmacyStaffGroup[];
}

export interface PharmacyDocument {
  id: string;
  type: string;
  label: string | null;
  fileUrl: string | null;
  fileType: string | null;
  fileSizeMb: number | null;
}

// ─── Finance ──────────────────────────────────────────────────────────────────

export interface FinanceChangeCard {
  value: number;
  change: string;
  trend: "up" | "down" | "neutral";
}

export interface FinanceCurrencyTotals {
  currency: string;
  usdValue: number | null;
  usdCurrency: string;
  nairaValue: number | null;
  nairaCurrency: string;
}

export interface FinanceStats {
  totalBalance: FinanceChangeCard & FinanceCurrencyTotals;
  totalAppointments: FinanceChangeCard;
  totalSales: FinanceChangeCard & FinanceCurrencyTotals;
}

export interface FinanceRevenueMonth {
  month: string;
  appointments: number;
  sales?: number;
  subscriptions?: number;
}

export interface FinanceRevenueData {
  year: number;
  type: string;
  months: FinanceRevenueMonth[];
}

export interface FinanceRevenueTrackingResponse {
  format: "json";
  data: FinanceRevenueData;
}

export interface FinanceRevenueTrackingQuery {
  year?: number;
  type?: "sales" | "subscriptions";
  format?: "json" | "csv";
}

export interface FinanceTransaction {
  id: string;
  payerName: string | null;
  paymentMode: string | null;
  bank: string | null;
  amount: number;
  currency: string | null;
  description: string;
  date: string | null;
  status: string | null;
  avatarUrl: string | null;
}

export interface FinanceAppointmentsHistoryResponse {
  total: number;
  page: number;
  limit: number;
  transactions: FinanceTransaction[];
}

export interface FinanceSubscriptionsHistoryResponse {
  total: number;
  page: number;
  limit: number;
  transactions: FinanceTransaction[];
}

export interface SaleTransaction {
  id: string;
  orderId: string | null;
  date: string | null;
  status: string | null;
  price: number;
  currency: string | null;
  customerName: string | null;
  customerEmail: string | null;
  avatarUrl: string | null;
}

export interface FinanceSalesHistoryResponse {
  total: number;
  page: number;
  limit: number;
  sales: SaleTransaction[];
}

export interface FinanceHistoryQuery {
  page?: number;
  limit?: number;
  date?: "today" | "week" | "month" | "all";
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export interface AnalyticsStats {
  appointments: number;
  doctors: number;
  patients: number;
  balance: number;
}

export interface AnalyticsDoctorsPercentage {
  month: string;
  totalDoctors: number;
  newDoctors: number;
  appointments: number;
  productPurchase: number;
}

export interface AnalyticsMonthDataPoint {
  month: string;
  value: number;
}

export interface AnalyticsPatientsStatistics {
  month: string;
  data: AnalyticsMonthDataPoint[];
}

export interface AnalyticsRevenueMonth {
  month: string;
  appointments: number;
  sales: number;
}

export interface AnalyticsRevenueData {
  year: number;
  months: AnalyticsRevenueMonth[];
}

export interface AnalyticsRevenueTrackingResponse {
  format: "json";
  data: AnalyticsRevenueData;
}

export interface AnalyticsRevenueTrackingQuery {
  year?: number;
  format?: "json" | "csv";
}

export interface AnalyticsAppointmentsMonth {
  month: string;
  appointments: number;
}

export interface AnalyticsAppointmentsData {
  year: number;
  months: AnalyticsAppointmentsMonth[];
}

export interface AnalyticsAppointmentsOverviewResponse {
  format: "json";
  data: AnalyticsAppointmentsData;
}

export interface AnalyticsAppointmentsOverviewQuery {
  year?: number;
  format?: "json" | "csv";
}

export interface AnalyticsSalesAnalytics {
  year: number;
  months: AnalyticsMonthDataPoint[];
}

export interface AnalyticsDeliveryOverview {
  year: number;
  months: AnalyticsMonthDataPoint[];
}

export interface AnalyticsBillingMemberships {
  month: string;
  data: AnalyticsMonthDataPoint[];
}

export interface AnalyticsMonthQuery {
  month?: string;
}

export interface AnalyticsYearQuery {
  year?: number;
}

// ─── Vendors ──────────────────────────────────────────────────────────────────

export interface VendorRow {
  id: string;
  businessName: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  joiningDate: string | null;
  status: "active" | "pending" | "inactive";
  avatarUrl: string | null;
}

export interface VendorsResponse {
  total: number;
  page: number;
  limit: number;
  vendors: VendorRow[];
}

export interface VendorsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: "active" | "pending" | "inactive" | "all";
}

export interface VendorHours {
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
}

export interface VendorDetail {
  id: string;
  businessName: string | null;
  registrationNumber: string | null;
  businessAddress: string | null;
  pharmacyWebsite: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  location: string | null;
  registrationDate: string | null;
  status: "active" | "pending" | "inactive";
  avatarUrl: string | null;
  hours: VendorHours;
  deliveryCapacity: boolean;
  staffCount: number;
}

export interface VendorDocument {
  id: string | null;
  label: string;
  fileSize: number | null;
  fileType: string | null;
  fileUrl: string | null;
  uploadedAt: string | null;
}

export type VendorProductStatus = "Available" | "Limited" | "Out of Stock";

export interface VendorProduct {
  id: string;
  no: number;
  name: string | null;
  productId: string;
  status: VendorProductStatus;
  totalStock: number;
  price: string;
  currency: string;
  sale: number;
  totalRevenue: string;
}

export interface VendorProductsResponse {
  total: number;
  page: number;
  limit: number;
  products: VendorProduct[];
}

export interface VendorProductsQuery {
  page?: number;
  limit?: number;
}

export type VendorOrderStatus = "Paid" | "Pending" | "Failed";

export interface VendorOrder {
  id: string;
  no: number;
  orderId: string;
  date: string | null;
  status: VendorOrderStatus;
  price: string;
  currency: string;
  customerName: string | null;
  customerEmail: string | null;
  customerAvatarUrl: string | null;
}

export interface VendorOrdersResponse {
  total: number;
  page: number;
  limit: number;
  orders: VendorOrder[];
}

export interface VendorOrdersQuery {
  page?: number;
  limit?: number;
  status?: "Paid" | "Pending" | "Failed" | "all";
}

export interface VendorMonthlyRow {
  month: string;
  value: number;
}

export interface VendorAnalyticsResponse {
  year: number;
  analytics: VendorMonthlyRow[];
}

export interface VendorPerformanceResponse {
  year: number;
  performance: VendorMonthlyRow[];
}

export interface VendorProductStats {
  total: number;
  totalItems: number;
  soldOut: number;
  newStock: number;
}

export interface VendorOrderStats {
  total: number;
  processing: number;
  processed: number;
  delivered: number;
}

export interface VendorStats {
  products: VendorProductStats;
  orders: VendorOrderStats;
}

export interface VendorYearQuery {
  year?: number;
}