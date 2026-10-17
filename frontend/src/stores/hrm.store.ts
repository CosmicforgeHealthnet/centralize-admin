import { inspectHttpError } from "@/lib/error-messages";
import { create } from "zustand";
import {
  accountsService,
  attendanceService,
  departmentsService,
  documentsService,
  hrmService,
  leavesService,
  performanceService,
  hiringService,
  payrollService,
  grantsService,
} from "@/lib/hrm.service";
import {
  AccountDetail,
  AccountListItem,
  AccountStatus,
  AttendanceLog,
  AttendanceRecord,
  AttendanceStats,
  AttendanceStatus,
  CreateAccountPayload,
  Department,
  DepartmentEmployee,
  DocumentEmployeeDetail,
  DocumentEmployeePicker,
  DownloadLeaveReportParams,
  EmployeeAttendanceOverview,
  EmployeeDetail,
  EmployeeDocument,
  EmployeeListItem,
  LeaveBalanceItem,
  LeaveChartPoint,
  LeaveDetail,
  LeaveHistoryItem,
  LeaveListItem,
  LeaveStats,
  LeaveStatus,
  ListAccountsParams,
  ListAttendanceParams,
  ListDepartmentEmployeesParams,
  ListDocumentEmployeesParams,
  ListEmployeeDocumentsParams,
  ListEmployeesParams,
  ListLeavesParams,
  PaginationMeta,
  UpdateAccountPayload,
  UploadDocumentPayload,
  PerformanceStats,
  PerformanceScore,
  PerformanceChartPoint,
  PerformanceTask,
  PerformanceTeam,
  PerformanceProject,
  PerformanceEmployee,
  PerformanceEvent,
  ListPerformanceTasksParams,
  ListPerformanceTeamsParams,
  ListPerformanceProjectsParams,
  ListPerformanceEmployeesParams,
  ListPerformanceEventsParams,
  CreatePerformanceEventPayload,
  HiringStats,
  HiringVacancy,
  HiringVacancyDetail,
  HiringApplicant,
  HiringApplicantDetail,
  ListVacanciesParams,
  ListApplicantsParams,
  CreateVacancyPayload,
  UpdateVacancyPayload,
  VacancyStatus,
  ApplicantStage,
  PayrollStats,
  PayrollStatus,
  PayrollRecord,
  PayslipRecord,
  PayslipDetail,
  DeductionRecord,
  ReceiptRecord,
  InvoiceRecord,
  EmployeePayroll,
  ListPayrollParams,
  ListPayslipsParams,
  ListReceiptsParams,
  ListDeductionsParams,
  ListInvoicesParams,
  UpdatePayrollPayload,
  DownloadPayrollReportParams,
  SectionGrant,
  CreateSectionGrantPayload,
} from "@/types/hrm.types";

function extractErrorMessage(err: unknown, fallback: string): string {
  const detail = inspectHttpError(err);
  if (detail.fieldErrors.length) return detail.fieldErrors.join(", ");
  return detail.message || detail.responseError || (err instanceof Error ? err.message : fallback);
}

interface AttendanceFilters {
  page: number;
  limit: number;
  date?: string;
  status?: AttendanceStatus;
  department?: string;
  search?: string;
}

interface AccountsFilters {
  page: number;
  limit: number;
  search?: string;
  filterBy?: "name" | "status" | "department" | "tier" | "designation";
  department?: string;
  tier?: string;
}

interface DocumentEmployeesFilters {
  page: number;
  limit: number;
  search?: string;
  filterBy?: "name" | "department" | "designation";
}

interface LeavesFilters {
  page: number;
  limit: number;
  status?: LeaveStatus;
  period?: string;
  employeeId?: string;
}

interface PerformanceFilters {
  page: number;
  limit: number;
  search?: string;
  department?: string;
  status?: string;
}

interface VacanciesFilters {
  page: number;
  limit: number;
  status?: VacancyStatus;
  search?: string;
  filterBy?: "department" | "category" | "title";
}

interface ApplicantsFilters {
  page: number;
  limit: number;
  search?: string;
  stage?: ApplicantStage | "All";
}

interface PayrollFilters {
  page: number;
  limit: number;
  status?: PayrollStatus;
}

interface PayslipFilters {
  page: number;
  limit: number;
}

interface ReceiptFilters {
  page: number;
  limit: number;
}

interface DeductionFilters {
  page: number;
  limit: number;
}

interface InvoiceFilters {
  page: number;
  limit: number;
}

interface HrmStore {
  employees: EmployeeListItem[];
  meta: PaginationMeta | null;
  selectedEmployee: EmployeeDetail | null;
  isLoadingList: boolean;
  isLoadingDetail: boolean;
  error: string | null;

  fetchEmployees: (params?: ListEmployeesParams) => Promise<void>;
  fetchEmployee: (id: string) => Promise<void>;
  clearSelectedEmployee: () => void;
  updateSelectedEmployeeLocally: (patch: Partial<EmployeeDetail>) => void;

  departments: Department[];
  departmentEmployees: DepartmentEmployee[];
  departmentMeta: PaginationMeta | null;
  isLoadingDepartments: boolean;
  isLoadingDepartmentEmployees: boolean;
  departmentsError: string | null;

  fetchDepartments: () => Promise<void>;
  fetchDepartmentEmployees: (dept: string, params?: ListDepartmentEmployeesParams) => Promise<void>;

  attendanceStats: AttendanceStats | null;
  isLoadingAttendanceStats: boolean;

  attendanceRecords: AttendanceRecord[];
  attendanceMeta: PaginationMeta | null;
  isLoadingAttendanceList: boolean;
  attendanceFilters: AttendanceFilters;

  selectedAttendanceOverview: EmployeeAttendanceOverview | null;
  isLoadingAttendanceOverview: boolean;

  attendanceLogs: AttendanceLog[];
  isLoadingAttendanceLogs: boolean;

  attendanceError: string | null;

  fetchAttendanceStats: (date?: string) => Promise<void>;
  fetchAttendance: (params?: Partial<ListAttendanceParams>) => Promise<void>;
  setAttendanceFilters: (patch: Partial<AttendanceFilters>) => void;
  setAttendancePage: (page: number) => void;

  fetchEmployeeAttendanceOverview: (employeeId: string, year?: number) => Promise<void>;
  fetchEmployeeAttendanceLogs: (employeeId: string, period?: string) => Promise<void>;
  clearSelectedAttendanceEmployee: () => void;

  accounts: AccountListItem[];
  accountsMeta: PaginationMeta | null;
  isLoadingAccounts: boolean;
  accountsFilters: AccountsFilters;
  accountsError: string | null;
  accountsSuccess: string | null;

  selectedAccount: AccountDetail | null;
  isLoadingAccount: boolean;
  isSavingAccount: boolean;

  fetchAccounts: (params?: Partial<ListAccountsParams>) => Promise<void>;
  setAccountsFilters: (patch: Partial<AccountsFilters>) => void;
  setAccountsPage: (page: number) => void;
  fetchAccount: (id: string) => Promise<void>;
  clearSelectedAccount: () => void;
  createAccount: (payload: CreateAccountPayload) => Promise<AccountDetail>;
  updateAccount: (id: string, payload: UpdateAccountPayload) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  updateAccountStatus: (id: string, status: "ACTIVE" | "INACTIVE") => Promise<void>;
  resendAccountInvite: (id: string) => Promise<void>;
  clearAccountsSuccess: () => void;

  sectionGrants: SectionGrant[];
  isLoadingGrants: boolean;
  grantsError: string | null;
  fetchUserGrants: (userId: string) => Promise<void>;
  addUserGrant: (userId: string, payload: CreateSectionGrantPayload) => Promise<SectionGrant | null>;
  removeUserGrant: (grantId: string) => Promise<void>;
  updateUserGrant: (grantId: string, payload: Partial<CreateSectionGrantPayload>) => Promise<void>;
  syncUserGrants: (userId: string, grants: CreateSectionGrantPayload[]) => Promise<void>;
  clearGrants: () => void;

  documentEmployees: DocumentEmployeePicker[];
  documentEmployeesMeta: PaginationMeta | null;
  isLoadingDocumentEmployees: boolean;
  documentEmployeesFilters: DocumentEmployeesFilters;
  documentsError: string | null;

  selectedDocEmployee: DocumentEmployeeDetail | null;
  employeeDocuments: EmployeeDocument[];
  isLoadingEmployeeDocuments: boolean;
  isUploadingDocument: boolean;

  fetchDocumentEmployees: (params?: Partial<ListDocumentEmployeesParams>) => Promise<void>;
  setDocumentEmployeesFilters: (patch: Partial<DocumentEmployeesFilters>) => void;
  setDocumentEmployeesPage: (page: number) => void;

  fetchEmployeeDocuments: (employeeId: string, params?: ListEmployeeDocumentsParams) => Promise<void>;
  uploadEmployeeDocument: (employeeId: string, payload: UploadDocumentPayload) => Promise<void>;
  deleteEmployeeDocument: (employeeId: string, docId: string) => Promise<void>;
  downloadEmployeeDocument: (employeeId: string, docId: string) => Promise<{ url: string; name: string }>;
  clearSelectedDocEmployee: () => void;

  leaveStats: LeaveStats | null;
  isLoadingLeaveStats: boolean;

  leaveChart: LeaveChartPoint[];
  isLoadingLeaveChart: boolean;

  leaves: LeaveListItem[];
  leavesMeta: PaginationMeta | null;
  isLoadingLeaves: boolean;
  leavesFilters: LeavesFilters;

  selectedLeave: LeaveDetail | null;
  isLoadingLeave: boolean;

  employeeLeaveHistory: LeaveHistoryItem[];
  isLoadingEmployeeLeaveHistory: boolean;

  employeeLeaveBalance: LeaveBalanceItem[];
  isLoadingEmployeeLeaveBalance: boolean;

  isUpdatingLeave: boolean;
  leavesError: string | null;

  fetchLeaveStats: () => Promise<void>;
  fetchLeaveChart: () => Promise<void>;
  fetchLeaves: (params?: Partial<ListLeavesParams>) => Promise<void>;
  setLeavesFilters: (patch: Partial<LeavesFilters>) => void;
  setLeavesPage: (page: number) => void;

  fetchLeave: (id: string) => Promise<void>;
  clearSelectedLeave: () => void;

  fetchEmployeeLeaveHistory: (employeeId: string) => Promise<void>;
  fetchEmployeeLeaveBalance: (employeeId: string) => Promise<void>;
  clearEmployeeLeaveData: () => void;

  approveLeave: (id: string) => Promise<void>;
  denyLeave: (id: string) => Promise<void>;
  approveAllLeaves: () => Promise<void>;
  downloadLeaveReport: (params?: DownloadLeaveReportParams) => Promise<Blob>;

  performanceStats: PerformanceStats | null;
  isLoadingPerformanceStats: boolean;

  performanceScore: PerformanceScore | null;
  isLoadingPerformanceScore: boolean;

  performanceChart: PerformanceChartPoint[];
  isLoadingPerformanceChart: boolean;

  performanceTasks: PerformanceTask[];
  performanceTasksMeta: PaginationMeta | null;
  isLoadingPerformanceTasks: boolean;
  performanceTasksFilters: PerformanceFilters;

  performanceTeams: PerformanceTeam[];
  performanceTeamsMeta: PaginationMeta | null;
  isLoadingPerformanceTeams: boolean;
  performanceTeamsFilters: PerformanceFilters;

  performanceProjects: PerformanceProject[];
  performanceProjectsMeta: PaginationMeta | null;
  isLoadingPerformanceProjects: boolean;
  performanceProjectsFilters: PerformanceFilters;

  performanceEmployees: PerformanceEmployee[];
  performanceEmployeesMeta: PaginationMeta | null;
  isLoadingPerformanceEmployees: boolean;
  performanceEmployeesFilters: PerformanceFilters;

  performanceEvents: PerformanceEvent[];
  isLoadingPerformanceEvents: boolean;

  selectedPerformanceEvent: PerformanceEvent | null;
  isLoadingPerformanceEvent: boolean;

  performanceError: string | null;
  isCreatingPerformanceEvent: boolean;

  fetchPerformanceStats: () => Promise<void>;
  fetchPerformanceScore: () => Promise<void>;
  fetchPerformanceChart: () => Promise<void>;

  fetchPerformanceTasks: (params?: Partial<ListPerformanceTasksParams>) => Promise<void>;
  setPerformanceTasksFilters: (patch: Partial<PerformanceFilters>) => void;
  setPerformanceTasksPage: (page: number) => void;

  fetchPerformanceTeams: (params?: Partial<ListPerformanceTeamsParams>) => Promise<void>;
  setPerformanceTeamsFilters: (patch: Partial<PerformanceFilters>) => void;
  setPerformanceTeamsPage: (page: number) => void;

  fetchPerformanceProjects: (params?: Partial<ListPerformanceProjectsParams>) => Promise<void>;
  setPerformanceProjectsFilters: (patch: Partial<PerformanceFilters>) => void;
  setPerformanceProjectsPage: (page: number) => void;

  fetchPerformanceEmployees: (params?: Partial<ListPerformanceEmployeesParams>) => Promise<void>;
  setPerformanceEmployeesFilters: (patch: Partial<PerformanceFilters>) => void;
  setPerformanceEmployeesPage: (page: number) => void;

  fetchPerformanceEvents: () => Promise<void>;
  createPerformanceEvent: (payload: CreatePerformanceEventPayload) => Promise<void>;
  fetchPerformanceEvent: (id: string) => Promise<void>;
  clearSelectedPerformanceEvent: () => void;

  hiringStats: HiringStats | null;
  isLoadingHiringStats: boolean;

  vacancies: HiringVacancy[];
  vacanciesMeta: PaginationMeta | null;
  isLoadingVacancies: boolean;
  vacanciesFilters: VacanciesFilters;

  selectedVacancy: HiringVacancyDetail | null;
  isLoadingVacancy: boolean;

  applicants: HiringApplicant[];
  applicantsMeta: PaginationMeta | null;
  isLoadingApplicants: boolean;
  applicantsFilters: ApplicantsFilters;

  selectedApplicant: HiringApplicantDetail | null;
  isLoadingApplicant: boolean;

  hiringError: string | null;
  isCreatingVacancy: boolean;
  isUpdatingVacancy: boolean;
  isUpdatingApplicant: boolean;

  fetchHiringStats: () => Promise<void>;
  fetchVacancies: (params?: Partial<ListVacanciesParams>) => Promise<void>;
  setVacanciesFilters: (patch: Partial<VacanciesFilters>) => void;
  setVacanciesPage: (page: number) => void;

  fetchVacancy: (id: string) => Promise<void>;
  clearSelectedVacancy: () => void;

  createVacancy: (payload: CreateVacancyPayload) => Promise<void>;
  updateVacancy: (id: string, payload: UpdateVacancyPayload) => Promise<void>;
  updateVacancyStatus: (id: string, status: VacancyStatus) => Promise<void>;
  deleteVacancy: (id: string) => Promise<void>;

  fetchApplicants: (vacancyId: string, params?: Partial<ListApplicantsParams>) => Promise<void>;
  setApplicantsFilters: (patch: Partial<ApplicantsFilters>) => void;
  setApplicantsPage: (page: number) => void;
  clearApplicants: () => void;

  fetchApplicant: (id: string) => Promise<void>;
  clearSelectedApplicant: () => void;

  updateApplicantStage: (id: string, stage: ApplicantStage) => Promise<void>;

  payrollStats: PayrollStats | null;
  isLoadingPayrollStats: boolean;

  payrollRecords: PayrollRecord[];
  payrollMeta: PaginationMeta | null;
  isLoadingPayroll: boolean;
  payrollFilters: PayrollFilters;

  payslips: PayslipRecord[];
  payslipsMeta: PaginationMeta | null;
  isLoadingPayslips: boolean;
  payslipsFilters: PayslipFilters;

  receipts: ReceiptRecord[];
  receiptsMeta: PaginationMeta | null;
  isLoadingReceipts: boolean;
  receiptsFilters: ReceiptFilters;

  deductions: DeductionRecord[];
  deductionsMeta: PaginationMeta | null;
  isLoadingDeductions: boolean;
  deductionsFilters: DeductionFilters;

  invoices: InvoiceRecord[];
  invoicesMeta: PaginationMeta | null;
  isLoadingInvoices: boolean;
  invoicesFilters: InvoiceFilters;

  selectedEmployeePayroll: EmployeePayroll | null;
  isLoadingEmployeePayroll: boolean;

  selectedPayslip: PayslipDetail | null;
  isLoadingPayslip: boolean;

  payrollError: string | null;
  isUpdatingPayroll: boolean;

  fetchPayrollStats: () => Promise<void>;
  fetchPayroll: (params?: Partial<ListPayrollParams>) => Promise<void>;
  setPayrollFilters: (patch: Partial<PayrollFilters>) => void;
  setPayrollPage: (page: number) => void;

  fetchPayslips: (params?: Partial<ListPayslipsParams>) => Promise<void>;
  setPayslipsFilters: (patch: Partial<PayslipFilters>) => void;
  setPayslipsPage: (page: number) => void;

  fetchReceipts: (params?: Partial<ListReceiptsParams>) => Promise<void>;
  setReceiptsFilters: (patch: Partial<ReceiptFilters>) => void;
  setReceiptsPage: (page: number) => void;

  fetchDeductions: (params?: Partial<ListDeductionsParams>) => Promise<void>;
  setDeductionsFilters: (patch: Partial<DeductionFilters>) => void;
  setDeductionsPage: (page: number) => void;

  fetchInvoices: (params?: Partial<ListInvoicesParams>) => Promise<void>;
  setInvoicesFilters: (patch: Partial<InvoiceFilters>) => void;
  setInvoicesPage: (page: number) => void;

  fetchEmployeePayroll: (employeeId: string, year?: number) => Promise<void>;
  clearEmployeePayroll: () => void;

  fetchEmployeePayslips: (employeeId: string, params?: Partial<ListPayslipsParams>) => Promise<void>;
  clearEmployeePayslips: () => void;

  fetchPayslipDetail: (employeeId: string, payslipId: string) => Promise<void>;
  clearSelectedPayslip: () => void;

  fetchEmployeeReceipts: (employeeId: string, params?: Partial<ListReceiptsParams>) => Promise<void>;
  clearEmployeeReceipts: () => void;

  fetchEmployeeDeductions: (employeeId: string, params?: Partial<ListDeductionsParams>) => Promise<void>;
  clearEmployeeDeductions: () => void;

  fetchEmployeeInvoices: (employeeId: string, params?: Partial<ListInvoicesParams>) => Promise<void>;
  clearEmployeeInvoices: () => void;

  updatePayroll: (employeeId: string, payload: UpdatePayrollPayload) => Promise<void>;
  downloadPayrollReport: (params?: DownloadPayrollReportParams) => Promise<Blob>;
}

export const useHrmStore = create<HrmStore>((set, get) => ({
  employees: [],
  meta: null,
  selectedEmployee: null,
  isLoadingList: false,
  isLoadingDetail: false,
  error: null,

  fetchEmployees: async (params) => {
    set({ isLoadingList: true, error: null });
    try {
      const { employees, meta } = await hrmService.listEmployees(params);
      set({ employees, meta, isLoadingList: false });
    } catch (err) {
      set({
        error: extractErrorMessage(err, "Failed to load employees"),
        isLoadingList: false,
      });
    }
  },

  fetchEmployee: async (id) => {
    set({ isLoadingDetail: true, error: null });
    try {
      const employee = await hrmService.getEmployee(id);
      set({ selectedEmployee: employee, isLoadingDetail: false });
    } catch (err) {
      set({
        error: extractErrorMessage(err, "Failed to load employee"),
        isLoadingDetail: false,
      });
    }
  },

  clearSelectedEmployee: () => set({ selectedEmployee: null }),

  updateSelectedEmployeeLocally: (patch) =>
    set((state) => ({
      selectedEmployee: state.selectedEmployee
        ? { ...state.selectedEmployee, ...patch }
        : state.selectedEmployee,
    })),

  departments: [],
  departmentEmployees: [],
  departmentMeta: null,
  isLoadingDepartments: false,
  isLoadingDepartmentEmployees: false,
  departmentsError: null,

  fetchDepartments: async () => {
    set({ isLoadingDepartments: true, departmentsError: null });
    try {
      const departments = await departmentsService.getDepartments();
      set({ departments, isLoadingDepartments: false });
    } catch (err) {
      set({
        departmentsError: extractErrorMessage(err, "Failed to load departments"),
        isLoadingDepartments: false,
      });
    }
  },

  fetchDepartmentEmployees: async (dept, params) => {
    set({ isLoadingDepartmentEmployees: true, departmentsError: null });
    try {
      const { data, meta } = await departmentsService.getDepartmentEmployees(dept, params);
      set({ departmentEmployees: data, departmentMeta: meta, isLoadingDepartmentEmployees: false });
    } catch (err) {
      set({
        departmentsError: extractErrorMessage(err, "Failed to load department employees"),
        isLoadingDepartmentEmployees: false,
      });
    }
  },

  attendanceStats: null,
  isLoadingAttendanceStats: false,

  attendanceRecords: [],
  attendanceMeta: null,
  isLoadingAttendanceList: false,
  attendanceFilters: { page: 1, limit: 10 },

  selectedAttendanceOverview: null,
  isLoadingAttendanceOverview: false,

  attendanceLogs: [],
  isLoadingAttendanceLogs: false,

  attendanceError: null,

  fetchAttendanceStats: async (date) => {
    set({ isLoadingAttendanceStats: true, attendanceError: null });
    try {
      const attendanceStats = await attendanceService.getStats(date ? { date } : {});
      set({ attendanceStats, isLoadingAttendanceStats: false });
    } catch (err) {
      set({
        attendanceError: extractErrorMessage(err, "Failed to load attendance stats"),
        isLoadingAttendanceStats: false,
      });
    }
  },

  fetchAttendance: async (params) => {
    const attendanceFilters = { ...get().attendanceFilters, ...params };
    set({ isLoadingAttendanceList: true, attendanceError: null, attendanceFilters });
    try {
      const { data, meta } = await attendanceService.listAttendance(attendanceFilters);
      set({ attendanceRecords: data, attendanceMeta: meta, isLoadingAttendanceList: false });
    } catch (err) {
      set({
        attendanceError: extractErrorMessage(err, "Failed to load attendance"),
        isLoadingAttendanceList: false,
      });
    }
  },

  setAttendanceFilters: (patch) => {
    const attendanceFilters = { ...get().attendanceFilters, ...patch, page: 1 };
    set({ attendanceFilters });
    get().fetchAttendance(attendanceFilters);
  },

  setAttendancePage: (page) => {
    const attendanceFilters = { ...get().attendanceFilters, page };
    set({ attendanceFilters });
    get().fetchAttendance(attendanceFilters);
  },

  fetchEmployeeAttendanceOverview: async (employeeId, year) => {
    set({ isLoadingAttendanceOverview: true, attendanceError: null });
    try {
      const overview = await attendanceService.getEmployeeOverview(employeeId, year);
      set({ selectedAttendanceOverview: overview, isLoadingAttendanceOverview: false });
    } catch (err) {
      set({
        attendanceError: extractErrorMessage(err, "Failed to load employee overview"),
        isLoadingAttendanceOverview: false,
      });
    }
  },

  fetchEmployeeAttendanceLogs: async (employeeId, period) => {
    set({ isLoadingAttendanceLogs: true, attendanceError: null });
    try {
      const attendanceLogs = await attendanceService.getEmployeeLogs(
        employeeId,
        period ? { period } : {},
      );
      set({ attendanceLogs, isLoadingAttendanceLogs: false });
    } catch (err) {
      set({
        attendanceError: extractErrorMessage(err, "Failed to load attendance logs"),
        isLoadingAttendanceLogs: false,
      });
    }
  },

  clearSelectedAttendanceEmployee: () => set({ selectedAttendanceOverview: null, attendanceLogs: [] }),

  accounts: [],
  accountsMeta: null,
  isLoadingAccounts: false,
  accountsFilters: { page: 1, limit: 10 },
  accountsError: null,
  accountsSuccess: null,

  selectedAccount: null,
  isLoadingAccount: false,
  isSavingAccount: false,

  fetchAccounts: async (params) => {
    const accountsFilters = { ...get().accountsFilters, ...params };
    set({ isLoadingAccounts: true, accountsError: null, accountsFilters });
    try {
      const { accounts, meta } = await accountsService.listAccounts(accountsFilters);
      set({ accounts, accountsMeta: meta, isLoadingAccounts: false });
    } catch (err) {
      set({
        accountsError: extractErrorMessage(err, "Failed to load accounts"),
        isLoadingAccounts: false,
      });
    }
  },

  setAccountsFilters: (patch) => {
    const accountsFilters = { ...get().accountsFilters, ...patch, page: 1 };
    set({ accountsFilters });
    get().fetchAccounts(accountsFilters);
  },

  setAccountsPage: (page) => {
    const accountsFilters = { ...get().accountsFilters, page };
    set({ accountsFilters });
    get().fetchAccounts(accountsFilters);
  },

  fetchAccount: async (id) => {
    set({ isLoadingAccount: true, accountsError: null });
    try {
      const selectedAccount = await accountsService.getAccount(id);
      set({ selectedAccount, isLoadingAccount: false });
    } catch (err) {
      set({
        accountsError: extractErrorMessage(err, "Failed to load account"),
        isLoadingAccount: false,
      });
    }
  },

  clearSelectedAccount: () => set({ selectedAccount: null }),

  createAccount: async (payload) => {
    set({ isSavingAccount: true, accountsError: null, accountsSuccess: null });
    try {
      const created = await accountsService.createAccount(payload);
      set({ 
        isSavingAccount: false,
        accountsSuccess: "Account created successfully! Invitation email sent."
      });
      await get().fetchAccounts();
      return created;
    } catch (err) {
      set({
        accountsError: extractErrorMessage(err, "Failed to create account"),
        isSavingAccount: false,
      });
      throw err;
    }
  },

  clearAccountsSuccess: () => set({ accountsSuccess: null }),

  updateAccount: async (id, payload) => {
    set({ isSavingAccount: true, accountsError: null, accountsSuccess: null });
    try {
      const updated = await accountsService.updateAccount(id, payload);
      set({ 
        selectedAccount: updated, 
        isSavingAccount: false,
        accountsSuccess: "Account updated successfully!"
      });
      await get().fetchAccounts();
    } catch (err) {
      set({
        accountsError: extractErrorMessage(err, "Failed to update account"),
        isSavingAccount: false,
      });
      throw err;
    }
  },

  deleteAccount: async (id) => {
    try {
      await accountsService.deleteAccount(id);
      await get().fetchAccounts();
    } catch (err) {
      set({
        accountsError: extractErrorMessage(err, "Failed to delete account"),
      });
      throw err;
    }
  },

  updateAccountStatus: async (id, status) => {
    try {
      const updated = await accountsService.updateStatus(id, status as "ACTIVE" | "INACTIVE");
      set({ selectedAccount: updated });
      await get().fetchAccounts();
    } catch (err) {
      set({
        accountsError: extractErrorMessage(err, "Failed to update account status"),
      });
      throw err;
    }
  },

  resendAccountInvite: async (id) => {
    try {
      await accountsService.resendInvite(id);
    } catch (err) {
      set({
        accountsError: extractErrorMessage(err, "Failed to resend invite"),
      });
      throw err;
    }
  },

  sectionGrants: [],
  isLoadingGrants: false,
  grantsError: null,

  fetchUserGrants: async (userId) => {
    set({ isLoadingGrants: true, grantsError: null });
    try {
      const grants = await grantsService.getUserGrants(userId);
      set({ sectionGrants: grants, isLoadingGrants: false });
    } catch (err) {
      set({
        grantsError: extractErrorMessage(err, "Failed to load permissions"),
        isLoadingGrants: false,
      });
    }
  },

  addUserGrant: async (userId, payload) => {
    set({ isLoadingGrants: true, grantsError: null });
    try {
      const grant = await grantsService.addGrant(userId, payload);
      if (grant && grant.id) {
        set((state) => ({
          sectionGrants: [...state.sectionGrants, grant],
          isLoadingGrants: false,
        }));
        return grant;
      } else {
        await get().fetchUserGrants(userId);
        set({ isLoadingGrants: false });
        return null;
      }
    } catch (err) {
      set({
        grantsError: extractErrorMessage(err, "Failed to add permission"),
        isLoadingGrants: false,
      });
      throw err;
    }
  },

  removeUserGrant: async (grantId) => {
    set({ isLoadingGrants: true, grantsError: null });
    try {
      await grantsService.removeGrant(grantId);
      set((state) => ({
        sectionGrants: state.sectionGrants.filter((g) => g.id !== grantId),
        isLoadingGrants: false,
      }));
    } catch (err) {
      set({
        grantsError: extractErrorMessage(err, "Failed to remove permission"),
        isLoadingGrants: false,
      });
      throw err;
    }
  },

  updateUserGrant: async (grantId, payload) => {
    set({ isLoadingGrants: true, grantsError: null });
    try {
      const updated = await grantsService.updateGrant(grantId, payload);
      set((state) => ({
        sectionGrants: state.sectionGrants.map((g) =>
          g.id === grantId ? updated : g
        ),
        isLoadingGrants: false,
      }));
    } catch (err) {
      set({
        grantsError: extractErrorMessage(err, "Failed to update permission"),
        isLoadingGrants: false,
      });
      throw err;
    }
  },

  syncUserGrants: async (userId, grants) => {
    set({ isLoadingGrants: true, grantsError: null });
    try {
      const newGrants = await grantsService.syncGrants(userId, grants);
      set({ sectionGrants: newGrants, isLoadingGrants: false });
    } catch (err) {
      set({
        grantsError: extractErrorMessage(err, "Failed to sync permissions"),
        isLoadingGrants: false,
      });
      throw err;
    }
  },

  clearGrants: () => set({ sectionGrants: [], grantsError: null }),

  documentEmployees: [],
  documentEmployeesMeta: null,
  isLoadingDocumentEmployees: false,
  documentEmployeesFilters: { page: 1, limit: 20 },
  documentsError: null,

  selectedDocEmployee: null,
  employeeDocuments: [],
  isLoadingEmployeeDocuments: false,
  isUploadingDocument: false,

  fetchDocumentEmployees: async (params) => {
    const documentEmployeesFilters = { ...get().documentEmployeesFilters, ...params };
    set({ isLoadingDocumentEmployees: true, documentsError: null, documentEmployeesFilters });
    try {
      const { data, meta } = await documentsService.getEmployees(documentEmployeesFilters);
      set({ documentEmployees: data, documentEmployeesMeta: meta, isLoadingDocumentEmployees: false });
    } catch (err) {
      set({
        documentsError: extractErrorMessage(err, "Failed to load employees"),
        isLoadingDocumentEmployees: false,
      });
    }
  },

  setDocumentEmployeesFilters: (patch) => {
    const documentEmployeesFilters = { ...get().documentEmployeesFilters, ...patch, page: 1 };
    set({ documentEmployeesFilters });
    get().fetchDocumentEmployees(documentEmployeesFilters);
  },

  setDocumentEmployeesPage: (page) => {
    const documentEmployeesFilters = { ...get().documentEmployeesFilters, page };
    set({ documentEmployeesFilters });
    get().fetchDocumentEmployees(documentEmployeesFilters);
  },

  fetchEmployeeDocuments: async (employeeId, params) => {
    set({ isLoadingEmployeeDocuments: true, documentsError: null });
    try {
      const { employee, documents } = await documentsService.getEmployeeDocuments(employeeId, params);
      set({ selectedDocEmployee: employee, employeeDocuments: documents, isLoadingEmployeeDocuments: false });
    } catch (err) {
      set({
        documentsError: extractErrorMessage(err, "Failed to load employee documents"),
        isLoadingEmployeeDocuments: false,
      });
    }
  },

  uploadEmployeeDocument: async (employeeId, payload) => {
    set({ isUploadingDocument: true, documentsError: null });
    try {
      await documentsService.uploadDocument(employeeId, payload);
      set({ isUploadingDocument: false });
      await get().fetchEmployeeDocuments(employeeId);
    } catch (err) {
      set({
        documentsError: extractErrorMessage(err, "Failed to upload document"),
        isUploadingDocument: false,
      });
      throw err;
    }
  },

  deleteEmployeeDocument: async (employeeId, docId) => {
    try {
      await documentsService.deleteDocument(employeeId, docId);
      await get().fetchEmployeeDocuments(employeeId);
    } catch (err) {
      set({
        documentsError: extractErrorMessage(err, "Failed to delete document"),
      });
      throw err;
    }
  },

  downloadEmployeeDocument: async (employeeId, docId) => {
    try {
      const result = await documentsService.downloadDocument(employeeId, docId);
      return { url: result.url, name: result.name };
    } catch (err) {
      set({
        documentsError: extractErrorMessage(err, "Failed to download document"),
      });
      throw err;
    }
  },

  clearSelectedDocEmployee: () => set({ selectedDocEmployee: null, employeeDocuments: [] }),

  leaveStats: null,
  isLoadingLeaveStats: false,

  leaveChart: [],
  isLoadingLeaveChart: false,

  leaves: [],
  leavesMeta: null,
  isLoadingLeaves: false,
  leavesFilters: { page: 1, limit: 10 },

  selectedLeave: null,
  isLoadingLeave: false,

  employeeLeaveHistory: [],
  isLoadingEmployeeLeaveHistory: false,

  employeeLeaveBalance: [],
  isLoadingEmployeeLeaveBalance: false,

  isUpdatingLeave: false,
  leavesError: null,

  fetchLeaveStats: async () => {
    set({ isLoadingLeaveStats: true, leavesError: null });
    try {
      const leaveStats = await leavesService.getStats();
      set({ leaveStats, isLoadingLeaveStats: false });
    } catch (err) {
      set({
        leavesError: extractErrorMessage(err, "Failed to load leave stats"),
        isLoadingLeaveStats: false,
      });
    }
  },

  fetchLeaveChart: async () => {
    set({ isLoadingLeaveChart: true, leavesError: null });
    try {
      const leaveChart = await leavesService.getChart();
      set({ leaveChart, isLoadingLeaveChart: false });
    } catch (err) {
      set({
        leavesError: extractErrorMessage(err, "Failed to load leave chart"),
        isLoadingLeaveChart: false,
      });
    }
  },

  fetchLeaves: async (params) => {
    const leavesFilters = { ...get().leavesFilters, ...params };
    set({ isLoadingLeaves: true, leavesError: null, leavesFilters });
    try {
      const { data, meta } = await leavesService.listLeaves(leavesFilters);
      set({ leaves: data, leavesMeta: meta, isLoadingLeaves: false });
    } catch (err) {
      set({
        leavesError: extractErrorMessage(err, "Failed to load leaves"),
        isLoadingLeaves: false,
      });
    }
  },

  setLeavesFilters: (patch) => {
    const leavesFilters = { ...get().leavesFilters, ...patch, page: 1 };
    set({ leavesFilters });
    get().fetchLeaves(leavesFilters);
  },

  setLeavesPage: (page) => {
    const leavesFilters = { ...get().leavesFilters, page };
    set({ leavesFilters });
    get().fetchLeaves(leavesFilters);
  },

  fetchLeave: async (id) => {
    set({ isLoadingLeave: true, leavesError: null });
    try {
      const selectedLeave = await leavesService.getLeave(id);
      set({ selectedLeave, isLoadingLeave: false });
    } catch (err) {
      set({
        leavesError: extractErrorMessage(err, "Failed to load leave request"),
        isLoadingLeave: false,
      });
    }
  },

  clearSelectedLeave: () => set({ selectedLeave: null }),

  fetchEmployeeLeaveHistory: async (employeeId) => {
    set({ isLoadingEmployeeLeaveHistory: true, leavesError: null });
    try {
      const employeeLeaveHistory = await leavesService.getEmployeeLeaves(employeeId);
      set({ employeeLeaveHistory, isLoadingEmployeeLeaveHistory: false });
    } catch (err) {
      set({
        leavesError: extractErrorMessage(err, "Failed to load leave history"),
        isLoadingEmployeeLeaveHistory: false,
      });
    }
  },

  fetchEmployeeLeaveBalance: async (employeeId) => {
    set({ isLoadingEmployeeLeaveBalance: true, leavesError: null });
    try {
      const employeeLeaveBalance = await leavesService.getEmployeeBalance(employeeId);
      set({ employeeLeaveBalance, isLoadingEmployeeLeaveBalance: false });
    } catch (err) {
      set({
        leavesError: extractErrorMessage(err, "Failed to load leave balance"),
        isLoadingEmployeeLeaveBalance: false,
      });
    }
  },

  clearEmployeeLeaveData: () => set({ employeeLeaveHistory: [], employeeLeaveBalance: [] }),

  approveLeave: async (id) => {
    set({ isUpdatingLeave: true, leavesError: null });
    try {
      const { status } = await leavesService.approveLeave(id);
      set((state) => ({
        isUpdatingLeave: false,
        selectedLeave: state.selectedLeave ? { ...state.selectedLeave, status: status as LeaveStatus } : state.selectedLeave,
      }));
      await get().fetchLeaves();
    } catch (err) {
      set({
        leavesError: extractErrorMessage(err, "Failed to approve leave"),
        isUpdatingLeave: false,
      });
      throw err;
    }
  },

  denyLeave: async (id) => {
    set({ isUpdatingLeave: true, leavesError: null });
    try {
      const { status } = await leavesService.denyLeave(id);
      set((state) => ({
        isUpdatingLeave: false,
        selectedLeave: state.selectedLeave ? { ...state.selectedLeave, status: status as LeaveStatus } : state.selectedLeave,
      }));
      await get().fetchLeaves();
    } catch (err) {
      set({
        leavesError: extractErrorMessage(err, "Failed to deny leave"),
        isUpdatingLeave: false,
      });
      throw err;
    }
  },

  approveAllLeaves: async () => {
    set({ isUpdatingLeave: true, leavesError: null });
    try {
      await leavesService.approveAll();
      set({ isUpdatingLeave: false });
      await get().fetchLeaves();
    } catch (err) {
      set({
        leavesError: extractErrorMessage(err, "Failed to approve all leaves"),
        isUpdatingLeave: false,
      });
      throw err;
    }
  },

  downloadLeaveReport: async (params) => {
    return leavesService.downloadReport(params);
  },

  performanceStats: null,
  isLoadingPerformanceStats: false,

  performanceScore: null,
  isLoadingPerformanceScore: false,

  performanceChart: [],
  isLoadingPerformanceChart: false,

  performanceTasks: [],
  performanceTasksMeta: null,
  isLoadingPerformanceTasks: false,
  performanceTasksFilters: { page: 1, limit: 8 },

  performanceTeams: [],
  performanceTeamsMeta: null,
  isLoadingPerformanceTeams: false,
  performanceTeamsFilters: { page: 1, limit: 8 },

  performanceProjects: [],
  performanceProjectsMeta: null,
  isLoadingPerformanceProjects: false,
  performanceProjectsFilters: { page: 1, limit: 8 },

  performanceEmployees: [],
  performanceEmployeesMeta: null,
  isLoadingPerformanceEmployees: false,
  performanceEmployeesFilters: { page: 1, limit: 8 },

  performanceEvents: [],
  isLoadingPerformanceEvents: false,

  selectedPerformanceEvent: null,
  isLoadingPerformanceEvent: false,

  performanceError: null,
  isCreatingPerformanceEvent: false,

  fetchPerformanceStats: async () => {
    set({ isLoadingPerformanceStats: true, performanceError: null });
    try {
      const performanceStats = await performanceService.getStats();
      set({ performanceStats, isLoadingPerformanceStats: false });
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to load performance stats"),
        isLoadingPerformanceStats: false,
      });
    }
  },

  fetchPerformanceScore: async () => {
    set({ isLoadingPerformanceScore: true, performanceError: null });
    try {
      const performanceScore = await performanceService.getScore();
      set({ performanceScore, isLoadingPerformanceScore: false });
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to load performance score"),
        isLoadingPerformanceScore: false,
      });
    }
  },

  fetchPerformanceChart: async () => {
    set({ isLoadingPerformanceChart: true, performanceError: null });
    try {
      const performanceChart = await performanceService.getChart();
      set({ performanceChart, isLoadingPerformanceChart: false });
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to load performance chart"),
        isLoadingPerformanceChart: false,
      });
    }
  },

  fetchPerformanceTasks: async (params) => {
    const performanceTasksFilters = { ...get().performanceTasksFilters, ...params };
    set({ isLoadingPerformanceTasks: true, performanceError: null, performanceTasksFilters });
    try {
      const { data, meta } = await performanceService.getTasks(performanceTasksFilters);
      set({ performanceTasks: data, performanceTasksMeta: meta, isLoadingPerformanceTasks: false });
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to load tasks"),
        isLoadingPerformanceTasks: false,
      });
    }
  },

  setPerformanceTasksFilters: (patch) => {
    const performanceTasksFilters = { ...get().performanceTasksFilters, ...patch, page: 1 };
    set({ performanceTasksFilters });
    get().fetchPerformanceTasks(performanceTasksFilters);
  },

  setPerformanceTasksPage: (page) => {
    const performanceTasksFilters = { ...get().performanceTasksFilters, page };
    set({ performanceTasksFilters });
    get().fetchPerformanceTasks(performanceTasksFilters);
  },

  fetchPerformanceTeams: async (params) => {
    const performanceTeamsFilters = { ...get().performanceTeamsFilters, ...params };
    set({ isLoadingPerformanceTeams: true, performanceError: null, performanceTeamsFilters });
    try {
      const { data, meta } = await performanceService.getTeams(performanceTeamsFilters);
      set({ performanceTeams: data, performanceTeamsMeta: meta, isLoadingPerformanceTeams: false });
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to load teams"),
        isLoadingPerformanceTeams: false,
      });
    }
  },

  setPerformanceTeamsFilters: (patch) => {
    const performanceTeamsFilters = { ...get().performanceTeamsFilters, ...patch, page: 1 };
    set({ performanceTeamsFilters });
    get().fetchPerformanceTeams(performanceTeamsFilters);
  },

  setPerformanceTeamsPage: (page) => {
    const performanceTeamsFilters = { ...get().performanceTeamsFilters, page };
    set({ performanceTeamsFilters });
    get().fetchPerformanceTeams(performanceTeamsFilters);
  },

  fetchPerformanceProjects: async (params) => {
    const performanceProjectsFilters = { ...get().performanceProjectsFilters, ...params };
    set({ isLoadingPerformanceProjects: true, performanceError: null, performanceProjectsFilters });
    try {
      const { data, meta } = await performanceService.getProjects(performanceProjectsFilters);
      set({ performanceProjects: data, performanceProjectsMeta: meta, isLoadingPerformanceProjects: false });
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to load projects"),
        isLoadingPerformanceProjects: false,
      });
    }
  },

  setPerformanceProjectsFilters: (patch) => {
    const performanceProjectsFilters = { ...get().performanceProjectsFilters, ...patch, page: 1 };
    set({ performanceProjectsFilters });
    get().fetchPerformanceProjects(performanceProjectsFilters);
  },

  setPerformanceProjectsPage: (page) => {
    const performanceProjectsFilters = { ...get().performanceProjectsFilters, page };
    set({ performanceProjectsFilters });
    get().fetchPerformanceProjects(performanceProjectsFilters);
  },

  fetchPerformanceEmployees: async (params) => {
    const performanceEmployeesFilters = { ...get().performanceEmployeesFilters, ...params };
    set({ isLoadingPerformanceEmployees: true, performanceError: null, performanceEmployeesFilters });
    try {
      const { data, meta } = await performanceService.getEmployees(performanceEmployeesFilters);
      set({ performanceEmployees: data, performanceEmployeesMeta: meta, isLoadingPerformanceEmployees: false });
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to load employees"),
        isLoadingPerformanceEmployees: false,
      });
    }
  },

  setPerformanceEmployeesFilters: (patch) => {
    const performanceEmployeesFilters = { ...get().performanceEmployeesFilters, ...patch, page: 1 };
    set({ performanceEmployeesFilters });
    get().fetchPerformanceEmployees(performanceEmployeesFilters);
  },

  setPerformanceEmployeesPage: (page) => {
    const performanceEmployeesFilters = { ...get().performanceEmployeesFilters, page };
    set({ performanceEmployeesFilters });
    get().fetchPerformanceEmployees(performanceEmployeesFilters);
  },

  fetchPerformanceEvents: async () => {
    set({ isLoadingPerformanceEvents: true, performanceError: null });
    try {
      const { data } = await performanceService.getEvents();
      set({ performanceEvents: data, isLoadingPerformanceEvents: false });
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to load events"),
        isLoadingPerformanceEvents: false,
      });
    }
  },

  createPerformanceEvent: async (payload) => {
    set({ isCreatingPerformanceEvent: true, performanceError: null });
    try {
      await performanceService.createEvent(payload);
      set({ isCreatingPerformanceEvent: false });
      await get().fetchPerformanceEvents();
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to create event"),
        isCreatingPerformanceEvent: false,
      });
      throw err;
    }
  },

  fetchPerformanceEvent: async (id) => {
    set({ isLoadingPerformanceEvent: true, performanceError: null });
    try {
      const selectedPerformanceEvent = await performanceService.getEvent(id);
      set({ selectedPerformanceEvent, isLoadingPerformanceEvent: false });
    } catch (err) {
      set({
        performanceError: extractErrorMessage(err, "Failed to load event"),
        isLoadingPerformanceEvent: false,
      });
    }
  },

  clearSelectedPerformanceEvent: () => set({ selectedPerformanceEvent: null }),

  hiringStats: null,
  isLoadingHiringStats: false,

  vacancies: [],
  vacanciesMeta: null,
  isLoadingVacancies: false,
  vacanciesFilters: { page: 1, limit: 10 },

  selectedVacancy: null,
  isLoadingVacancy: false,

  applicants: [],
  applicantsMeta: null,
  isLoadingApplicants: false,
  applicantsFilters: { page: 1, limit: 10 },

  selectedApplicant: null,
  isLoadingApplicant: false,

  hiringError: null,
  isCreatingVacancy: false,
  isUpdatingVacancy: false,
  isUpdatingApplicant: false,

  fetchHiringStats: async () => {
    set({ isLoadingHiringStats: true, hiringError: null });
    try {
      const hiringStats = await hiringService.getStats();
      set({ hiringStats, isLoadingHiringStats: false });
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to load hiring stats"),
        isLoadingHiringStats: false,
      });
    }
  },

  fetchVacancies: async (params) => {
    const vacanciesFilters = { ...get().vacanciesFilters, ...params };
    set({ isLoadingVacancies: true, hiringError: null, vacanciesFilters });
    try {
      const { data, meta } = await hiringService.listVacancies(vacanciesFilters);
      set({ vacancies: data, vacanciesMeta: meta, isLoadingVacancies: false });
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to load vacancies"),
        isLoadingVacancies: false,
      });
    }
  },

  setVacanciesFilters: (patch) => {
    const vacanciesFilters = { ...get().vacanciesFilters, ...patch, page: 1 };
    set({ vacanciesFilters });
    get().fetchVacancies(vacanciesFilters);
  },

  setVacanciesPage: (page) => {
    const vacanciesFilters = { ...get().vacanciesFilters, page };
    set({ vacanciesFilters });
    get().fetchVacancies(vacanciesFilters);
  },

  fetchVacancy: async (id) => {
    set({ isLoadingVacancy: true, hiringError: null });
    try {
      const selectedVacancy = await hiringService.getVacancy(id);
      set({ selectedVacancy, isLoadingVacancy: false });
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to load vacancy"),
        isLoadingVacancy: false,
      });
    }
  },

  clearSelectedVacancy: () => set({ selectedVacancy: null }),

  createVacancy: async (payload) => {
    set({ isCreatingVacancy: true, hiringError: null });
    try {
      await hiringService.createVacancy(payload);
      set({ isCreatingVacancy: false });
      await get().fetchVacancies();
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to create vacancy"),
        isCreatingVacancy: false,
      });
      throw err;
    }
  },

  updateVacancy: async (id, payload) => {
    set({ isUpdatingVacancy: true, hiringError: null });
    try {
      await hiringService.updateVacancy(id, payload);
      set({ isUpdatingVacancy: false });
      await get().fetchVacancies();
      await get().fetchVacancy(id);
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to update vacancy"),
        isUpdatingVacancy: false,
      });
      throw err;
    }
  },

  updateVacancyStatus: async (id, status) => {
    set({ isUpdatingVacancy: true, hiringError: null });
    try {
      await hiringService.updateVacancyStatus(id, { status });
      set({ isUpdatingVacancy: false });
      await get().fetchVacancies();
      await get().fetchVacancy(id);
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to update vacancy status"),
        isUpdatingVacancy: false,
      });
      throw err;
    }
  },

  deleteVacancy: async (id) => {
    set({ isUpdatingVacancy: true, hiringError: null });
    try {
      await hiringService.deleteVacancy(id);
      set({ isUpdatingVacancy: false });
      await get().fetchVacancies();
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to delete vacancy"),
        isUpdatingVacancy: false,
      });
      throw err;
    }
  },

  fetchApplicants: async (vacancyId, params) => {
    const applicantsFilters = { ...get().applicantsFilters, ...params };
    set({ isLoadingApplicants: true, hiringError: null, applicantsFilters });
    try {
      const { data, meta } = await hiringService.listApplicants(vacancyId, applicantsFilters);
      set({ applicants: data, applicantsMeta: meta, isLoadingApplicants: false });
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to load applicants"),
        isLoadingApplicants: false,
      });
    }
  },

  setApplicantsFilters: (patch) => {
    const applicantsFilters = { ...get().applicantsFilters, ...patch, page: 1 };
    set({ applicantsFilters });
  },

  setApplicantsPage: (page) => {
    const applicantsFilters = { ...get().applicantsFilters, page };
    set({ applicantsFilters });
  },

  clearApplicants: () => set({ applicants: [], applicantsMeta: null }),

  fetchApplicant: async (id) => {
    set({ isLoadingApplicant: true, hiringError: null });
    try {
      const selectedApplicant = await hiringService.getApplicant(id);
      set({ selectedApplicant, isLoadingApplicant: false });
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to load applicant"),
        isLoadingApplicant: false,
      });
    }
  },

  clearSelectedApplicant: () => set({ selectedApplicant: null }),

  updateApplicantStage: async (id, stage) => {
    set({ isUpdatingApplicant: true, hiringError: null });
    try {
      await hiringService.updateApplicantStage(id, { stage });
      set({ isUpdatingApplicant: false });
    } catch (err) {
      set({
        hiringError: extractErrorMessage(err, "Failed to update applicant stage"),
        isUpdatingApplicant: false,
      });
      throw err;
    }
  },

  payrollStats: null,
  isLoadingPayrollStats: false,

  payrollRecords: [],
  payrollMeta: null,
  isLoadingPayroll: false,
  payrollFilters: { page: 1, limit: 10 },

  payslips: [],
  payslipsMeta: null,
  isLoadingPayslips: false,
  payslipsFilters: { page: 1, limit: 10 },

  receipts: [],
  receiptsMeta: null,
  isLoadingReceipts: false,
  receiptsFilters: { page: 1, limit: 10 },

  deductions: [],
  deductionsMeta: null,
  isLoadingDeductions: false,
  deductionsFilters: { page: 1, limit: 10 },

  invoices: [],
  invoicesMeta: null,
  isLoadingInvoices: false,
  invoicesFilters: { page: 1, limit: 10 },

  selectedEmployeePayroll: null,
  isLoadingEmployeePayroll: false,

  selectedPayslip: null,
  isLoadingPayslip: false,

  payrollError: null,
  isUpdatingPayroll: false,

  fetchPayrollStats: async () => {
    set({ isLoadingPayrollStats: true, payrollError: null });
    try {
      const payrollStats = await payrollService.getStats();
      set({ payrollStats, isLoadingPayrollStats: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load payroll stats"),
        isLoadingPayrollStats: false,
      });
    }
  },

  fetchPayroll: async (params) => {
    const payrollFilters = { ...get().payrollFilters, ...params };
    set({ isLoadingPayroll: true, payrollError: null, payrollFilters });
    try {
      const { data, meta } = await payrollService.listPayroll(payrollFilters);
      set({ payrollRecords: data, payrollMeta: meta, isLoadingPayroll: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load payroll"),
        isLoadingPayroll: false,
      });
    }
  },

  setPayrollFilters: (patch) => {
    const payrollFilters = { ...get().payrollFilters, ...patch, page: 1 };
    set({ payrollFilters });
    get().fetchPayroll(payrollFilters);
  },

  setPayrollPage: (page) => {
    const payrollFilters = { ...get().payrollFilters, page };
    set({ payrollFilters });
    get().fetchPayroll(payrollFilters);
  },

  fetchPayslips: async (params) => {
    const payslipsFilters = { ...get().payslipsFilters, ...params };
    set({ isLoadingPayslips: true, payrollError: null, payslipsFilters });
    try {
      const { data, meta } = await payrollService.listPayslips(payslipsFilters);
      set({ payslips: data, payslipsMeta: meta, isLoadingPayslips: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load payslips"),
        isLoadingPayslips: false,
      });
    }
  },

  setPayslipsFilters: (patch) => {
    const payslipsFilters = { ...get().payslipsFilters, ...patch, page: 1 };
    set({ payslipsFilters });
    get().fetchPayslips(payslipsFilters);
  },

  setPayslipsPage: (page) => {
    const payslipsFilters = { ...get().payslipsFilters, page };
    set({ payslipsFilters });
    get().fetchPayslips(payslipsFilters);
  },

  fetchReceipts: async (params) => {
    const receiptsFilters = { ...get().receiptsFilters, ...params };
    set({ isLoadingReceipts: true, payrollError: null, receiptsFilters });
    try {
      const { data, meta } = await payrollService.listReceipts(receiptsFilters);
      set({ receipts: data, receiptsMeta: meta, isLoadingReceipts: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load receipts"),
        isLoadingReceipts: false,
      });
    }
  },

  setReceiptsFilters: (patch) => {
    const receiptsFilters = { ...get().receiptsFilters, ...patch, page: 1 };
    set({ receiptsFilters });
    get().fetchReceipts(receiptsFilters);
  },

  setReceiptsPage: (page) => {
    const receiptsFilters = { ...get().receiptsFilters, page };
    set({ receiptsFilters });
    get().fetchReceipts(receiptsFilters);
  },

  fetchDeductions: async (params) => {
    const deductionsFilters = { ...get().deductionsFilters, ...params };
    set({ isLoadingDeductions: true, payrollError: null, deductionsFilters });
    try {
      const { data, meta } = await payrollService.listDeductions(deductionsFilters);
      set({ deductions: data, deductionsMeta: meta, isLoadingDeductions: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load deductions"),
        isLoadingDeductions: false,
      });
    }
  },

  setDeductionsFilters: (patch) => {
    const deductionsFilters = { ...get().deductionsFilters, ...patch, page: 1 };
    set({ deductionsFilters });
    get().fetchDeductions(deductionsFilters);
  },

  setDeductionsPage: (page) => {
    const deductionsFilters = { ...get().deductionsFilters, page };
    set({ deductionsFilters });
    get().fetchDeductions(deductionsFilters);
  },

  fetchInvoices: async (params) => {
    const invoicesFilters = { ...get().invoicesFilters, ...params };
    set({ isLoadingInvoices: true, payrollError: null, invoicesFilters });
    try {
      const { data, meta } = await payrollService.listInvoices(invoicesFilters);
      set({ invoices: data, invoicesMeta: meta, isLoadingInvoices: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load invoices"),
        isLoadingInvoices: false,
      });
    }
  },

  setInvoicesFilters: (patch) => {
    const invoicesFilters = { ...get().invoicesFilters, ...patch, page: 1 };
    set({ invoicesFilters });
    get().fetchInvoices(invoicesFilters);
  },

  setInvoicesPage: (page) => {
    const invoicesFilters = { ...get().invoicesFilters, page };
    set({ invoicesFilters });
    get().fetchInvoices(invoicesFilters);
  },

  fetchEmployeePayroll: async (employeeId, year) => {
    set({ isLoadingEmployeePayroll: true, payrollError: null });
    try {
      const selectedEmployeePayroll = await payrollService.getEmployeePayroll(employeeId, year);
      set({ selectedEmployeePayroll, isLoadingEmployeePayroll: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load employee payroll"),
        isLoadingEmployeePayroll: false,
      });
    }
  },

  clearEmployeePayroll: () => set({ selectedEmployeePayroll: null }),

  fetchEmployeePayslips: async (employeeId, params) => {
    set({ isLoadingPayslips: true, payrollError: null });
    try {
      const { data, meta } = await payrollService.getEmployeePayslips(employeeId, params);
      set({ payslips: data, payslipsMeta: meta, isLoadingPayslips: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load employee payslips"),
        isLoadingPayslips: false,
      });
    }
  },

  clearEmployeePayslips: () => set({ payslips: [], payslipsMeta: null }),

  fetchPayslipDetail: async (employeeId, payslipId) => {
    set({ isLoadingPayslip: true, payrollError: null });
    try {
      const selectedPayslip = await payrollService.getPayslipDetail(employeeId, payslipId);
      set({ selectedPayslip, isLoadingPayslip: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load payslip detail"),
        isLoadingPayslip: false,
      });
    }
  },

  clearSelectedPayslip: () => set({ selectedPayslip: null }),

  fetchEmployeeReceipts: async (employeeId, params) => {
    set({ isLoadingReceipts: true, payrollError: null });
    try {
      const { data, meta } = await payrollService.getEmployeeReceipts(employeeId, params);
      set({ receipts: data, receiptsMeta: meta, isLoadingReceipts: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load employee receipts"),
        isLoadingReceipts: false,
      });
    }
  },

  clearEmployeeReceipts: () => set({ receipts: [], receiptsMeta: null }),

  fetchEmployeeDeductions: async (employeeId, params) => {
    set({ isLoadingDeductions: true, payrollError: null });
    try {
      const { data, meta } = await payrollService.getEmployeeDeductions(employeeId, params);
      set({ deductions: data, deductionsMeta: meta, isLoadingDeductions: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load employee deductions"),
        isLoadingDeductions: false,
      });
    }
  },

  clearEmployeeDeductions: () => set({ deductions: [], deductionsMeta: null }),

  fetchEmployeeInvoices: async (employeeId, params) => {
    set({ isLoadingInvoices: true, payrollError: null });
    try {
      const { data, meta } = await payrollService.getEmployeeInvoices(employeeId, params);
      set({ invoices: data, invoicesMeta: meta, isLoadingInvoices: false });
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to load employee invoices"),
        isLoadingInvoices: false,
      });
    }
  },

  clearEmployeeInvoices: () => set({ invoices: [], invoicesMeta: null }),

  updatePayroll: async (employeeId, payload) => {
    set({ isUpdatingPayroll: true, payrollError: null });
    try {
      await payrollService.updatePayroll(employeeId, payload);
      set({ isUpdatingPayroll: false });
      await get().fetchEmployeePayroll(employeeId);
    } catch (err) {
      set({
        payrollError: extractErrorMessage(err, "Failed to update payroll"),
        isUpdatingPayroll: false,
      });
      throw err;
    }
  },

  downloadPayrollReport: async (params) => {
    return payrollService.downloadReport(params);
  },
}));