export type EmployeeTier = "EMPLOYEE" | "ADMIN" | "EXECUTIVE";
export type EmployeeStatus = "ACTIVE" | "INACTIVE" | "SUSPENDED";

export const LEAVE_STATUSES = ["PENDING", "APPROVED", "DENIED"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export interface LeaveListItem {
  id: string;
  adminUserId: string;
  name: string | null;
  email: string | null;
  leaveType: string;
  startDate: string | null;
  resumptionDate: string | null;
  status: LeaveStatus;
  avatarUrl: string | null;
}

export interface LeaveEmployeeInfo {
  id: string | null;
  name: string | null;
  employeeCode: string | null;
  phone: string | null;
  email: string | null;
  position: string | null;
  location: string | null;
  headOfDepartment: string | null;
  employmentDate: string | null;
  avatarUrl: string | null;
}

export interface LeaveDetail {
  id: string;
  leaveType: string;
  startDate: string | null;
  resumptionDate: string | null;
  reason: string | null;
  status: LeaveStatus;
  attachmentUrl: string | null;
  attachmentName: string | null;
  employee: LeaveEmployeeInfo;
}

export interface LeaveHistoryItem {
  id: string;
  leaveType: string;
  startDate: string | null;
  resumptionDate: string | null;
  status: LeaveStatus;
}

export interface LeaveBalanceItem {
  leaveType: string;
  availableDays: number;
  usedDays: number;
}

export interface LeaveStatsChanges {
  totalChange: number;
  newChange: number;
  rejectedChange: number;
  pendingChange: number;
}

export interface LeaveStats {
  totalRequests: number;
  newRequests: number;
  rejectedRequests: number;
  pendingRequests: number;
  changes: LeaveStatsChanges;
}

export interface LeaveChartPoint {
  month: string;
  value: number;
}

export interface ListLeavesParams {
  page?: number;
  limit?: number;
  status?: LeaveStatus;
  period?: string;
  employeeId?: string;
}

export interface DownloadLeaveReportParams {
  status?: LeaveStatus;
  period?: string;
  employeeId?: string;
}

export interface EmployeeListItem {
  id: string;
  employeeCode: string | null;
  name: string;
  email: string;
  department: string | null;
  designation: string | null;
  position: string | null;
  employmentType: string | null;
  employmentCategory: string | null;
  location: string | null;
  tier: EmployeeTier;
  status: EmployeeStatus;
  avatarUrl: string | null;
  employmentDate: string;
}

export interface EmployeeSocialLink {
  id: string;
  platform: string;
  username: string;
}

export interface EmployeeEducation {
  id: string;
  degreeTitle: string;
  institution: string;
  from: string | null;
  to: string | null;
  createdAt: string;
}

export interface EmployeeDocument {
  id: string;
  name: string;
  type: string;
  url: string;
  uploadedBy: string | null;
  uploadedAt: string;
}

export interface EmployeeReport {
  id: string;
  title: string;
  type: string;
  body: string | null;
  note: string | null;
  url: string | null;
  createdBy: string | null;
  date: string;
}

export interface EmployeePerformanceNote {
  id: string;
  title: string;
  type: string;
  url: string | null;
  createdBy: string | null;
  date: string;
}

export interface EmployeeTeam {
  id: string;
  title: string;
  department: string | null;
  isTeamLead: boolean;
  joinedAt: string;
}

export interface EmployeeProject {
  id: string;
  title: string;
  description: string | null;
  assignedDate: string | null;
  dueDate: string | null;
  status: string;
  assignedAt: string;
}

export interface EmployeeTask {
  id: string;
  title: string;
  description: string | null;
  assignedDate: string | null;
  dueDate: string | null;
  status: string;
}

export interface EmployeeDetail {
  id: string;
  employeeCode: string | null;
  name: string;
  email: string;
  tier: EmployeeTier;
  status: EmployeeStatus;
  avatarUrl: string | null;
  personalInfo: {
    preferredName: string | null;
    birthday: string | null;
    nationality: string | null;
    gender: string | null;
    maritalStatus: string | null;
  };
  contactInfo: {
    workPhone: string | null;
    homePhone: string | null;
    personalPhone: string | null;
    fax: string | null;
    address: string | null;
    state: string | null;
    country: string | null;
  };
  employmentInfo: {
    employmentDate: string;
    position: string | null;
    jobTitle: string | null;
    designation: string | null;
    department: string | null;
    location: string | null;
    headOfDepartment: string | null;
    employmentType: string | null;
    employmentCategory: string | null;
    isTeamLead: boolean;
  };
  emergencyContact: {
    name: string | null;
    phone: string | null;
    email: string | null;
    relation: string | null;
  };
  socialLinks: EmployeeSocialLink[];
  education: EmployeeEducation[];
  documents: EmployeeDocument[];
  reports: EmployeeReport[];
  performanceNotes: EmployeePerformanceNote[];
  teams: EmployeeTeam[];
  projects: EmployeeProject[];
  tasks: EmployeeTask[];
  sensitive?: {
    salary: number | null;
    bonus: number | null;
    equity: number | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ListEmployeesParams {
  page?: number;
  limit?: number;
  department?: string;
  search?: string;
}

export interface UpdatePersonalPayload {
  name?: string;
  preferredName?: string;
  birthday?: string;
  nationality?: string;
  gender?: string;
  maritalStatus?: string;
}

export interface UpdateContactPayload {
  workPhone?: string;
  homePhone?: string;
  personalPhone?: string;
  fax?: string;
  address?: string;
  state?: string;
  country?: string;
}

export interface UpdateEmploymentPayload {
  position?: string;
  department?: string;
  employmentType?: string;
  employmentCategory?: string;
  location?: string;
  isTeamLead?: boolean;
  tier?: EmployeeTier;
  status?: EmployeeStatus;
}

export interface UpdateEmergencyPayload {
  emergencyName?: string;
  emergencyPhone?: string;
  emergencyEmail?: string;
  emergencyRelation?: string;
}

export interface UpdateSocialPayload {
  platform: string;
  username: string;
}

export interface UpdateSensitivePayload {
  salary?: number;
  bonus?: number;
  equity?: number;
}

export interface EducationPayload {
  degreeTitle: string;
  institution: string;
  from?: string;
  to?: string;
}

export interface Department {
  id: string;
  label: string;
  count: number;
}

export interface DepartmentEmployee {
  id: string;
  name: string;
  email: string;
  employeeCode: string | null;
  employmentType: string | null;
  department: string | null;
  designation: string | null;
  avatarUrl: string | null;
  employmentDate: string;
}

export interface ListDepartmentEmployeesParams {
  page?: number;
  limit?: number;
}

export type AttendanceStatus = "PRESENT" | "LATE" | "ABSENT";

export interface AttendanceRecord {
  id: string;
  adminUserId: string;
  name: string | null;
  email: string | null;
  employeeCode: string | null;
  employmentType: string | null;
  department: string | null;
  designation: string | null;
  clockIn: string | null;
  clockOut: string | null;
  status: AttendanceStatus;
  date: string;
  avatarUrl: string | null;
}

export interface AttendanceLog {
  id: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  status: AttendanceStatus;
}

export interface AttendanceStatsChanges {
  presentChange: number;
  lateChange: number;
  absentChange: number;
  checkInChange: number;
}

export interface AttendanceStats {
  totalPresent: number;
  lateArrivals: number;
  totalAbsent: number;
  averageCheckIn: string | null;
  changes: AttendanceStatsChanges;
}

export interface AttendanceChartPoint {
  month: string;
  present: number;
  late: number;
  absent: number;
}

export interface EmployeeAttendanceOverview {
  employee: {
    id: string;
    name: string;
    department: string | null;
    employmentType: string | null;
    employmentCategory: string | null;
    employmentDate: string;
  };
  chartData: AttendanceChartPoint[];
}

export interface ListAttendanceParams {
  page?: number;
  limit?: number;
  date?: string;
  status?: AttendanceStatus;
  department?: string;
  search?: string;
}

export interface AttendanceStatsParams {
  date?: string;
}

export type AttendancePeriod = "This Week" | "Last Week" | "This Month";

export interface EmployeeLogsParams {
  period?: AttendancePeriod;
}

export interface CreateAttendancePayload {
  adminUserId: string;
  date: string;
  clockIn?: string | null;
  clockOut?: string | null;
  status: AttendanceStatus;
}

export interface UpdateAttendancePayload {
  clockIn?: string | null;
  clockOut?: string | null;
  status?: AttendanceStatus;
}

export interface DownloadAttendanceReportParams {
  date?: string;
  status?: AttendanceStatus;
  department?: string;
  search?: string;
  employeeId?: string;
}

export const ACCOUNT_DEPARTMENTS = [
  "FINANCE",
  "DEVELOPMENT",
  "CUSTOMER_CARE",
  "MARKETING",
  "SOCIAL_MEDIA",
  "EXECUTIVE",
  "MANAGEMENT",
] as const;
export type AccountDepartment = (typeof ACCOUNT_DEPARTMENTS)[number];

export const ACCOUNT_TIERS = ["SUPER", "EXECUTIVE", "ADMIN", "EMPLOYEE"] as const;
export type AccountTier = (typeof ACCOUNT_TIERS)[number];

export const ACCOUNT_STATUSES = ["ACTIVE", "INACTIVE", "LOCKED", "PENDING"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export function formatEnumLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface AccountListItem {
  id: string;
  employeeCode: string | null;
  name: string;
  email: string;
  employmentType: string | null;
  employmentCategory: string | null;
  department: AccountDepartment | null;
  designation: string | null;
  tier: AccountTier;
  status: AccountStatus;
  avatarUrl: string | null;
}

export interface AccountDetail {
  id: string;
  employeeCode: string | null;
  name: string;
  email: string;
  phone: string | null;
  personalPhone: string | null;
  employmentDate: string;
  position: string | null;
  jobTitle: string | null;
  designation: string | null;
  department: AccountDepartment | null;
  location: string | null;
  headOfDepartment: string | null;
  employmentType: string | null;
  employmentCategory: string | null;
  tier: AccountTier;
  status: AccountStatus;
  sectionGrants?: SectionGrant[];
}

export interface ListAccountsParams {
  page?: number;
  limit?: number;
  department?: AccountDepartment | string;
  tier?: AccountTier | string;
  search?: string;
  filterBy?: "name" | "department" | "tier" | "status" | "designation";
  includeGrants?: boolean;
}

export interface CreateAccountPayload {
  name: string;
  email: string;
  position?: string;
  department?: AccountDepartment;
  tier?: AccountTier;
  isTeamLead?: boolean;
  employmentType?: string;
  employmentCategory?: string;
  location?: string;
  personalPhone?: string;
}

export interface UpdateAccountPayload {
  name?: string;
  email?: string;
  position?: string;
  department?: AccountDepartment;
  tier?: AccountTier;
  status?: AccountStatus;
  isTeamLead?: boolean;
  employmentType?: string;
  employmentCategory?: string;
  location?: string;
  personalPhone?: string;
}

export interface DocumentEmployeePicker {
  id: string;
  employeeCode: string | null;
  name: string;
  email: string;
  department: string | null;
  designation: string | null;
  avatarUrl: string | null;
  status: string;
}

export interface ListDocumentEmployeesParams {
  page?: number;
  limit?: number;
  search?: string;
  filterBy?: "name" | "department" | "designation";
}

export interface DocumentEmployeeDetail {
  id: string;
  name: string;
  employeeCode: string | null;
  phone: string | null;
  email: string;
  position: string | null;
  location: string | null;
  headOfDepartment: string | null;
  employmentDate: string | null;
  avatarUrl: string | null;
}

export const DOCUMENT_FORMATS = ["XLS", "XLSX", "PDF", "DOXT", "DOC", "DOCX"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export interface EmployeeDocument {
  id: string;
  title: string;
  name: string;
  type: string;
  url: string;
  uploadedBy: string | null;
  uploadedAt: string;
  expiryDate: string | null;
}

export interface ListEmployeeDocumentsParams {
  search?: string;
  filterBy?: "type" | "date";
}

export interface GetEmployeeDocumentsResult {
  employee: DocumentEmployeeDetail;
  documents: EmployeeDocument[];
}

export interface UploadDocumentPayload {
  title: string;
  format: DocumentFormat;
  expiry?: string;
  file: File;
}

export interface DownloadDocumentResult {
  url: string;
  name: string;
  type: string;
}

// ─── Performance ──────────────────────────────────────────────────────────────

export interface PerformanceStats {
  totalEmployees: number;
  totalTeams: number;
  totalTasks: number;
  totalProjects: number;
  totalEvents: number;
  changes: {
    employeesChange: number;
    teamsChange: number;
    tasksChange: number;
    projectsChange: number;
    eventsChange: number;
  };
}

export interface PerformanceScore {
  score: number;
  bars: {
    label: string;
    value: number;
    color: string;
  }[];
  upcomingEvent: {
    id: string;
    title: string;
    date: string;
    time: string;
  } | null;
}

export interface PerformanceChartPoint {
  month: string;
  marketing: number;
  development: number;
  socialMedia: number;
}

export interface PerformanceTask {
  id: string;
  title: string;
  assignee: {
    name: string | null;
    email: string | null;
    employeeCode: string | null;
    department: string | null;
  };
  assignedDate: string | null;
  dueDate: string | null;
  status: string;
}

export interface PerformanceTeam {
  id: string;
  projectTitle: string;
  team: string | null;
  teamLead: string | null;
  members: number;
  assignedDate: string | null;
  dueDate: string | null;
  status: string;
}

export interface PerformanceProject {
  id: string;
  title: string;
  team: string | null;
  teamLead: string | null;
  members: number;
  assignedDate: string | null;
  dueDate: string | null;
  status: string;
}

export interface PerformanceEmployee {
  id: string;
  name: string;
  email: string;
  employeeCode: string | null;
  department: string | null;
  task: string | null;
  assignedDate: string | null;
  dueDate: string | null;
  status: string | null;
}

export interface PerformanceEvent {
  id: string;
  title: string;
  description: string | null;
  date: string;
  time: string;
  location: string | null;
}

export type PerformanceFilterBy = "Task" | "Team" | "Project" | "Employee";

export interface ListPerformanceTasksParams {
  page?: number;
  limit?: number;
  search?: string;
  department?: string;
  status?: string;
}

export interface ListPerformanceTeamsParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}

export interface ListPerformanceProjectsParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}

export interface ListPerformanceEmployeesParams {
  page?: number;
  limit?: number;
  search?: string;
  department?: string;
  status?: string;
}

export interface ListPerformanceEventsParams {
  page?: number;
  limit?: number;
}

export interface CreatePerformanceEventPayload {
  title: string;
  description?: string;
  date: string;
  time: string;
  location?: string;
}

// ─── Hiring ──────────────────────────────────────────────────────────────────

export type VacancyStatus = "OPEN" | "IN_REVIEW" | "CLOSED";
export type ApplicantStage = "SCREENING" | "INTERVIEW" | "HIRED" | "REJECTED";

export interface HiringStats {
  numberOfOpenings: number;
  applicationsReceived: number;
  changes: {
    openingsChange: number;
    applicationsChange: number;
  };
}

export interface HiringVacancy {
  id: string;
  title: string;
  department: string | null;
  category: string | null;
  location: string | null;
  numberOfOpening: number;
  applicantsCount: number;
  status: VacancyStatus;
  createdAt: string;
}

export interface HiringVacancyDetail {
  id: string;
  title: string;
  department: string | null;
  category: string | null;
  location: string | null;
  numberOfOpening: number;
  experienceLevel: string | null;
  salaryRange: string | null;
  benefitsAndBonus: string | null;
  jobDescription: string | null;
  responsibilities: string | null;
  requirements: string | null;
  hiringStages: string | null;
  assignedRecruiter: string | null;
  deadline: string | null;
  status: VacancyStatus;
  applicantsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface HiringApplicant {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  stage: ApplicantStage;
  via: string | null;
  applicationDate: string;
}

export interface HiringApplicantDetail {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  stage: ApplicantStage;
  via: string | null;
  applicationDate: string;
  coverLetter: string | null;
  vacancy: {
    id: string | null;
    title: string | null;
    category: string | null;
    location: string | null;
    department: string | null;
  };
  attachments: {
    id: string;
    url: string;
    name: string | null;
    type: string | null;
  }[];
}

export interface ListVacanciesParams {
  page?: number;
  limit?: number;
  status?: VacancyStatus;
  search?: string;
  filterBy?: "department" | "category" | "title";
}

export interface ListApplicantsParams {
  page?: number;
  limit?: number;
  search?: string;
  stage?: ApplicantStage | "All";
}

export interface CreateVacancyPayload {
  title: string;
  department?: string;
  category?: string;
  location?: string;
  numberOfOpening?: number;
  experienceLevel?: string;
  salaryRange?: string;
  benefitsAndBonus?: string;
  jobDescription?: string;
  responsibilities?: string;
  requirements?: string;
  hiringStages?: string;
  assignedRecruiter?: string;
  deadline?: string;
  status?: VacancyStatus;
}

export interface UpdateVacancyPayload {
  title?: string;
  department?: string;
  category?: string;
  location?: string;
  numberOfOpening?: number;
  experienceLevel?: string;
  salaryRange?: string;
  benefitsAndBonus?: string;
  jobDescription?: string;
  responsibilities?: string;
  requirements?: string;
  hiringStages?: string;
  assignedRecruiter?: string;
  deadline?: string;
  status?: VacancyStatus;
}

export interface UpdateVacancyStatusPayload {
  status: VacancyStatus;
}

export interface UpdateApplicantStagePayload {
  stage: ApplicantStage;
}

// ─── Payroll ──────────────────────────────────────────────────────────────────

export type PayrollStatus = "PAID" | "PENDING";

export interface PayrollStats {
  totalEmployees: number;
  totalPayroll: number;
  pendingPayroll: number;
  paidPayroll: number;
  changes: {
    totalPayrollChange: number;
    pendingPayrollChange: number;
    paidPayrollChange: number;
    employeesChange: number;
  };
}

export interface PayrollRecord {
  id: string;
  adminUserId: string;
  name: string | null;
  email: string | null;
  employeeCode: string | null;
  employmentType: string | null;
  department: string | null;
  designation: string | null;
  netPay: number;
  status: PayrollStatus;
  avatarUrl: string | null;
  month: number;
  year: number;
}

export interface PayslipRecord {
  id: string;
  adminUserId: string;
  name: string | null;
  email: string | null;
  month: number;
  year: number;
  netPay: number;
  paymentMethod: string | null;
  paymentDate: string | null;
}

export interface PayslipDetail {
  id: string;
  employee: {
    id: string;
    name: string;
    email: string;
    employeeCode: string | null;
    department: string | null;
    designation: string | null;
    avatarUrl: string | null;
  };
  month: number;
  year: number;
  paymentMethod: string | null;
  paymentDate: string | null;
  basicSalary: number;
  allowance: number;
  bonus: number;
  deductions: Record<string, unknown>;
  netPay: number;
}

export interface DeductionRecord {
  id: string;
  adminUserId: string;
  name: string | null;
  email: string | null;
  deductionName: string;
  amount: number;
  month: number;
  year: number;
}

export interface ReceiptRecord {
  id: string;
  adminUserId: string;
  name: string | null;
  email: string | null;
  amount: number;
  description: string | null;
  month: number;
  year: number;
  createdAt: string;
}

export interface InvoiceRecord {
  id: string;
  adminUserId: string;
  name: string | null;
  email: string | null;
  amount: number;
  description: string | null;
  dueDate: string | null;
  status: string;
  month: number;
  year: number;
}

export interface EmployeePayroll {
  employee: {
    id: string;
    name: string;
    email: string;
    employeeCode: string | null;
    employmentType: string | null;
    department: string | null;
    designation: string | null;
    avatarUrl: string | null;
  };
  payroll: {
    id: string;
    month: number;
    year: number;
    totalSalary: number;
    allowance: number;
    bonus: number;
    deductions: number;
    grossPay: number;
    netPay: number;
    status: PayrollStatus;
    paymentDate: string | null;
    paymentMethod: string | null;
    bankName: string | null;
    bankAccount: string | null;
  } | null;
  chartData: {
    month: string;
    netPay: number;
  }[];
}

export interface PayrollChartPoint {
  month: string;
  netPay: number;
}

export interface ListPayrollParams {
  page?: number;
  limit?: number;
  status?: PayrollStatus;
}

export interface ListPayslipsParams {
  page?: number;
  limit?: number;
}

export interface ListReceiptsParams {
  page?: number;
  limit?: number;
}

export interface ListDeductionsParams {
  page?: number;
  limit?: number;
}

export interface ListInvoicesParams {
  page?: number;
  limit?: number;
}

export interface UpdatePayrollPayload {
  month: number;
  year: number;
  totalSalary?: number;
  totalAllowance?: number;
  totalBonus?: number;
  totalDeductions?: number;
  paymentMethod?: string;
  bankName?: string;
  bankAccount?: string;
}

export interface DownloadPayrollReportParams {
  status?: PayrollStatus;
}

// ─── SECTION GRANTS ──────────────────────────────────────────────────────────

export const MODULES = {
  HRM: "hrm",
  MARKETING: "marketing",
  FINANCE: "finance",
  VERIFICATION: "verification",
  OPERATIONS: "operations",
  RTC: "rtc",
  TELEMEDICINE: "telemedicine",
} as const;

export type Module = (typeof MODULES)[keyof typeof MODULES];

export const MODULE_SECTIONS: Record<Module, string[]> = {
  hrm: ["accounts", "payroll", "employees", "attendance", "leaves", "departments", "hiring"],
  marketing: ["campaigns", "analytics", "social", "content", "banners", "promotions", "intelligence", "advertising"],
  finance: ["payments", "invoices", "reports", "transactions"],
  verification: ["doctors", "patients", "pharmacy", "labs", "vendors"],
  operations: ["dispatch", "logistics", "delivery"],
  rtc: ["sessions", "calls", "recordings"],
  telemedicine: ["consultations", "prescriptions", "records"],
};

export type SectionGrantMode = "VIEW" | "EDIT";

export interface SectionGrant {
  id: string;
  module: Module;
  section: string;
  mode: SectionGrantMode;
  grantedBy: string;
  reason?: string;
  expiresAt?: string | null;
  createdAt: string;
  revokedAt?: string | null;
}

export interface CreateSectionGrantPayload {
  module: Module;
  section: string;
  mode: SectionGrantMode;
  reason?: string;
  expiresAt?: string;
}

export interface SyncSectionGrantsPayload {
  grants: CreateSectionGrantPayload[];
}