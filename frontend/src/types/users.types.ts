export interface UserStats {
  total: number;
  totalDoctors: number;
  totalPatients: number;
  totalPharmacies: number;
  totalLabs: number;
  activeUsers: number;
  inactiveUsers: number;
  lockedUsers: number;
  pendingVerification: number;
  newToday: number;
  newThisWeek: number;
  newThisMonth: number;
  growthRate: number;
}

export interface GrowthChartItem {
  month: string;
  total: number;
  doctors: number;
  patients: number;
  others: number;
}

export interface SignUpTrendItem {
  month: string;
  Doctors: number;
  Patients: number;
  Pharmacies: number;
  Labs: number;
}

export interface User {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
  tier: string;
  phoneNumber: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Subscription {
  id: string;
  tier: string;
  planType: string;
  status: string;
  startDate: string;
  endDate: string;
  price: number;
  currency: string;
  billingCycle: string;
  autoRenew: boolean;
  canceledAt: string | null;
  createdAt: string;
}

export interface UserDetail extends User {
  profileImageUrl: string | null;
  updatedAt: string;
  subscriptions: Subscription[];
  doctor_profiles: {
    gender: string | null;
    dateOfBirth: string | null;
    nationality: string | null;
    contactNumber: string | null;
    professional_licenses: {
      medicalLicenseNumber: string | null;
      countryOfLicense: string | null;
      licenseAuthority: string | null;
      licenseExpiryDate: string | null;
      yearsOfExperience: number | null;
      areasOfSpecialization: string[] | null;
    }[];
  } | null;
  patient_profiles: {
    gender: string | null;
    dateOfBirth: string | null;
    bloodGroup: string | null;
    genotype: string | null;
    nationality: string | null;
  } | null;
  pharmacy_profiles: {
    pharmacyName: string | null;
    registrationNumber: string | null;
    address: string | null;
    phone: string | null;
    verificationStatus: string | null;
    isActive: boolean | null;
  } | null;
}

export interface UserActivity {
  appointments: number;
  transactions: number;
  prescriptions: number;
  labOrders: number;
}

export interface UserTransaction {
  id: string;
  serviceType: string;
  originalAmount: number;
  originalCurrency: string;
  status: string;
  paymentProvider: string;
  createdAt: string;
  completedAt: string | null;
}

export interface UserAppointment {
  id: string;
  appointmentDate: string;
  appointmentTime: string;
  status: string;
  type: string;
  reason: string | null;
  consultationFee: number;
  paymentStatus: string;
  createdAt: string;
}

export interface UsersFilters {
  search: string;
  role: string;
  status: string;
  tier: string;
  dateFrom: string;
  dateTo: string;
  sortBy: string;
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export interface UsersPagination {
  currentPage: number;
  totalPages: number;
  totalItems: number;
}

export interface BulkUpdateResult {
  updated: number;
}

// ─── Analytics Types (append to users.types.ts) ──────────────────────────────

export interface AnalyticsStats {
  total_visitors: number;
  unique_sessions: number;
  returning_visitors: number;
  by_user_type: Record<string, number>;
  top_pages: { page: string; count: number }[];
  top_traffic_sources: { source: string; count: number }[];
  by_country: { country: string; count: number }[];
  by_device: Record<string, number>;
  plan_interest: { type: string; count: number }[];
  conversions: {
    total: number;
    rate: string;
  };
}

export interface VisitorSession {
  session_id: string;
  first_seen: string;
  last_seen: string;
  is_returning_visitor: boolean;
  user_type_intent: string;
  geo_country: string | null;
  geo_city: string | null;
  device_type: string | null;
  referrer: string | null;
  utm_campaign: string | null;
  pages_visited: string[];
  events_count: number;
  converted: boolean;
  conversion_event: string | null;
}

export interface WaitlistEntry {
  id: string;
  session_id: string;
  role: string;
  full_name: string | null;
  facility_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  signed_up_at: string;
}

export interface AnalyticsPagination {
  total: number;
  page: number;
  limit: number;
}