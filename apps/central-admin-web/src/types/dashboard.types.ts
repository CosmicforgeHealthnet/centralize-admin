export interface StatCard {
  value: number | string;
  change: string;
  positive: boolean;
  period: string;
}

export interface StatCards {
  totalUsers: StatCard;
  activeUsersThisWeek: StatCard;
  totalRevenue: StatCard;
  activeDoctors: StatCard;
  activePatients: StatCard;
}

export interface MembershipActivity {
  total: number;
  doctorPercentage: string;
  patientPercentage: string;
  doctorCount: number;
  patientCount: number;
}

export interface UserActivity {
  newDoctors: StatCard;
  newPatients: StatCard;
  appointments: StatCard;
}

export interface DashboardOverview {
  statCards: StatCards;
  membershipActivity: MembershipActivity;
  userActivity: UserActivity;
}

export interface RevenueChartItem {
  month: string;
  Appointments: string;
  Membership: string;
}

export interface PlatformUsageItem {
  month: string;
  Consultation: number;
  Lab: number;
  Pharmacy: number;
  AI: number;
}