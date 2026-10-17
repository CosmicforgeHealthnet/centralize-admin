import api from "./api";
import {
  AccountDetail,
  AccountListItem,
  AttendanceLog,
  AttendanceRecord,
  AttendanceStats,
  AttendanceStatsParams,
  CreateAccountPayload,
  CreateAttendancePayload,
  Department,
  DepartmentEmployee,
  DocumentEmployeePicker,
  DownloadAttendanceReportParams,
  DownloadDocumentResult,
  DownloadLeaveReportParams,
  EducationPayload,
  EmployeeAttendanceOverview,
  EmployeeDetail,
  EmployeeDocument,
  EmployeeEducation,
  EmployeeListItem,
  EmployeeLogsParams,
  EmployeeSocialLink,
  GetEmployeeDocumentsResult,
  LeaveBalanceItem,
  LeaveChartPoint,
  LeaveDetail,
  LeaveHistoryItem,
  LeaveListItem,
  LeaveStats,
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
  UpdateAttendancePayload,
  UpdateContactPayload,
  UpdateEmergencyPayload,
  UpdateEmploymentPayload,
  UpdatePersonalPayload,
  UpdateSensitivePayload,
  UpdateSocialPayload,
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
  UpdateVacancyStatusPayload,
  UpdateApplicantStagePayload,
  PayrollStats,
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
  VacancyStatus,
  ApplicantStage,
  SectionGrant,
  CreateSectionGrantPayload,
  SyncSectionGrantsPayload,
  Module,
  SectionGrantMode,
} from "@/types/hrm.types";

const BASE = "/api/hrm/employees";
const DEPT_BASE = "/api/hrm/departments";
const ATTENDANCE_BASE = "/api/hrm/attendance";
const ACCOUNTS_BASE = "/api/hrm/accounts";
const DOCUMENTS_BASE = "/api/hrm/documents";
const LEAVES_BASE = "/api/hrm/leaves";
const PERFORMANCE_BASE = "/api/hrm/performance";
const HIRING_BASE = "/api/hrm/hiring";
const PAYROLL_BASE = "/api/hrm/payroll";

interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

export const hrmService = {
  async listEmployees(params: ListEmployeesParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ employees: EmployeeListItem[]; meta: PaginationMeta }>>(
      BASE,
      { params },
    );
    return data.data;
  },

  async getEmployee(id: string) {
    const { data } = await api.get<ApiEnvelope<EmployeeDetail>>(`${BASE}/${id}`);
    return data.data;
  },

  async updatePersonal(id: string, payload: UpdatePersonalPayload) {
    const { data } = await api.put<ApiEnvelope<EmployeeDetail>>(`${BASE}/${id}/personal`, payload);
    return data.data;
  },

  async updateContact(id: string, payload: UpdateContactPayload) {
    const { data } = await api.put<ApiEnvelope<EmployeeDetail>>(`${BASE}/${id}/contact`, payload);
    return data.data;
  },

  async updateEmployment(id: string, payload: UpdateEmploymentPayload) {
    const { data } = await api.put<ApiEnvelope<EmployeeDetail>>(`${BASE}/${id}/employment`, payload);
    return data.data;
  },

  async updateEmergency(id: string, payload: UpdateEmergencyPayload) {
    const { data } = await api.put<ApiEnvelope<EmployeeDetail>>(`${BASE}/${id}/emergency`, payload);
    return data.data;
  },

  async updateSocial(id: string, links: UpdateSocialPayload[]) {
    const { data } = await api.put<ApiEnvelope<EmployeeSocialLink[]>>(`${BASE}/${id}/social`, { links });
    return data.data;
  },

  async updateSensitive(id: string, payload: UpdateSensitivePayload) {
    await api.put(`${BASE}/${id}/sensitive`, payload);
  },

  async updateAvatar(id: string, file: File) {
    const formData = new FormData();
    formData.append("avatar", file);
    const { data } = await api.put<ApiEnvelope<{ id: string; avatarUrl: string }>>(
      `${BASE}/${id}/avatar`,
      formData,
      { headers: { "Content-Type": "multipart/form-data" } },
    );
    return data.data;
  },

  async listEducation(id: string) {
    const { data } = await api.get<ApiEnvelope<EmployeeEducation[]>>(`${BASE}/${id}/education`);
    return data.data;
  },

  async createEducation(id: string, payload: EducationPayload) {
    const { data } = await api.post<ApiEnvelope<EmployeeEducation>>(`${BASE}/${id}/education`, payload);
    return data.data;
  },

  async updateEducation(id: string, educationId: string, payload: EducationPayload) {
    const { data } = await api.put<ApiEnvelope<EmployeeEducation>>(
      `${BASE}/${id}/education/${educationId}`,
      payload,
    );
    return data.data;
  },

  async deleteEducation(id: string, educationId: string) {
    await api.delete(`${BASE}/${id}/education/${educationId}`);
  },
};

export const departmentsService = {
  async getDepartments() {
    const { data } = await api.get<ApiEnvelope<Department[]>>(DEPT_BASE);
    return data.data;
  },

  async getDepartmentEmployees(dept: string, params: ListDepartmentEmployeesParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: DepartmentEmployee[]; meta: PaginationMeta }>>(
      `${DEPT_BASE}/${dept}/employees`,
      { params },
    );
    return data.data;
  },
};

export const attendanceService = {
  async getStats(params: AttendanceStatsParams = {}) {
    const { data } = await api.get<ApiEnvelope<AttendanceStats>>(`${ATTENDANCE_BASE}/stats`, { params });
    return data.data;
  },

  async listAttendance(params: ListAttendanceParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: AttendanceRecord[]; meta: PaginationMeta }>>(
      ATTENDANCE_BASE,
      { params },
    );
    return data.data;
  },

  async getEmployeeOverview(employeeId: string, year?: number) {
    const { data } = await api.get<ApiEnvelope<EmployeeAttendanceOverview>>(
      `${ATTENDANCE_BASE}/${employeeId}`,
      { params: year ? { year } : {} },
    );
    return data.data;
  },

  async getEmployeeLogs(employeeId: string, params: EmployeeLogsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: AttendanceLog[] }>>(
      `${ATTENDANCE_BASE}/${employeeId}/logs`,
      { params },
    );
    return data.data.data;
  },

  async createAttendance(payload: CreateAttendancePayload) {
    const { data } = await api.post<ApiEnvelope<{ id: string }>>(ATTENDANCE_BASE, payload);
    return data.data;
  },

  async updateAttendance(id: string, payload: UpdateAttendancePayload) {
    await api.put(`${ATTENDANCE_BASE}/${id}`, payload);
  },

  async downloadReport(params: DownloadAttendanceReportParams = {}) {
    const response = await api.get(`${ATTENDANCE_BASE}/report/download`, {
      params,
      responseType: "blob",
    });
    return response.data as Blob;
  },
};

export const accountsService = {
  async listAccounts(params: ListAccountsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ accounts: AccountListItem[]; meta: PaginationMeta }>>(
      ACCOUNTS_BASE,
      { params },
    );
    return data.data;
  },

  async getAccount(id: string) {
    const { data } = await api.get<ApiEnvelope<AccountDetail>>(`${ACCOUNTS_BASE}/${id}`);
    return data.data;
  },

  async createAccount(payload: CreateAccountPayload) {
    const { data } = await api.post<ApiEnvelope<AccountDetail>>(ACCOUNTS_BASE, payload);
    return data.data;
  },

  async updateAccount(id: string, payload: UpdateAccountPayload) {
    const { data } = await api.put<ApiEnvelope<AccountDetail>>(`${ACCOUNTS_BASE}/${id}`, payload);
    return data.data;
  },

  async deleteAccount(id: string) {
    await api.delete(`${ACCOUNTS_BASE}/${id}`);
  },

  async updateStatus(id: string, status: "ACTIVE" | "INACTIVE") {
    const { data } = await api.patch<ApiEnvelope<AccountDetail>>(`${ACCOUNTS_BASE}/${id}/status`, { status });
    return data.data;
  },

  async resendInvite(id: string) {
    await api.post(`${ACCOUNTS_BASE}/${id}/invite`);
  },
};

export const documentsService = {
  async getEmployees(params: ListDocumentEmployeesParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: DocumentEmployeePicker[]; meta: PaginationMeta }>>(
      `${DOCUMENTS_BASE}/employees`,
      { params },
    );
    return data.data;
  },

  async getEmployeeDocuments(employeeId: string, params: ListEmployeeDocumentsParams = {}) {
    const { data } = await api.get<ApiEnvelope<GetEmployeeDocumentsResult>>(
      `${DOCUMENTS_BASE}/${employeeId}`,
      { params },
    );
    return data.data;
  },

  async uploadDocument(employeeId: string, payload: UploadDocumentPayload) {
    const formData = new FormData();
    formData.append("file", payload.file);
    formData.append("title", payload.title);
    formData.append("format", payload.format);
    if (payload.expiry) formData.append("expiry", payload.expiry);

    const { data } = await api.post<ApiEnvelope<EmployeeDocument>>(
      `${DOCUMENTS_BASE}/${employeeId}`,
      formData,
      { headers: { "Content-Type": "multipart/form-data" } },
    );
    return data.data;
  },

  async deleteDocument(employeeId: string, docId: string) {
    await api.delete(`${DOCUMENTS_BASE}/${employeeId}/${docId}`);
  },

  async downloadDocument(employeeId: string, docId: string) {
    const { data } = await api.get<ApiEnvelope<DownloadDocumentResult>>(
      `${DOCUMENTS_BASE}/${employeeId}/${docId}/download`,
    );
    return data.data;
  },
};

export const leavesService = {
  async getStats() {
    const { data } = await api.get<ApiEnvelope<LeaveStats>>(`${LEAVES_BASE}/stats`);
    return data.data;
  },

  async getChart() {
    const { data } = await api.get<ApiEnvelope<{ data: LeaveChartPoint[] }>>(`${LEAVES_BASE}/chart`);
    return data.data.data;
  },

  async listLeaves(params: ListLeavesParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: LeaveListItem[]; meta: PaginationMeta }>>(
      LEAVES_BASE,
      { params },
    );
    return data.data;
  },

  async getLeave(id: string) {
    const { data } = await api.get<ApiEnvelope<LeaveDetail>>(`${LEAVES_BASE}/${id}`);
    return data.data;
  },

  async getEmployeeLeaves(employeeId: string) {
    const { data } = await api.get<ApiEnvelope<{ data: LeaveHistoryItem[] }>>(
      `${LEAVES_BASE}/employee/${employeeId}`,
    );
    return data.data.data;
  },

  async getEmployeeBalance(employeeId: string) {
    const { data } = await api.get<ApiEnvelope<{ data: LeaveBalanceItem[] }>>(
      `${LEAVES_BASE}/employee/${employeeId}/balance`,
    );
    return data.data.data;
  },

  async approveLeave(id: string) {
    const { data } = await api.patch<ApiEnvelope<{ status: string }>>(`${LEAVES_BASE}/${id}/approve`);
    return data.data;
  },

  async denyLeave(id: string) {
    const { data } = await api.patch<ApiEnvelope<{ status: string }>>(`${LEAVES_BASE}/${id}/deny`);
    return data.data;
  },

  async approveAll() {
    const { data } = await api.patch<ApiEnvelope<{ count: number }>>(`${LEAVES_BASE}/approve-all`);
    return data.data;
  },

  async downloadReport(params: DownloadLeaveReportParams = {}) {
    const response = await api.get(`${LEAVES_BASE}/report/download`, {
      params,
      responseType: "blob",
    });
    return response.data as Blob;
  },
};

export const performanceService = {
  async getStats() {
    const { data } = await api.get<ApiEnvelope<PerformanceStats>>(`${PERFORMANCE_BASE}/stats`);
    return data.data;
  },

  async getScore() {
    const { data } = await api.get<ApiEnvelope<PerformanceScore>>(`${PERFORMANCE_BASE}/score`);
    return data.data;
  },

  async getChart() {
    const { data } = await api.get<ApiEnvelope<{ data: PerformanceChartPoint[] }>>(`${PERFORMANCE_BASE}/chart`);
    return data.data.data;
  },

  async getTasks(params: ListPerformanceTasksParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: PerformanceTask[]; meta: PaginationMeta }>>(
      `${PERFORMANCE_BASE}/tasks`,
      { params }
    );
    return data.data;
  },

  async getTeams(params: ListPerformanceTeamsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: PerformanceTeam[]; meta: PaginationMeta }>>(
      `${PERFORMANCE_BASE}/teams`,
      { params }
    );
    return data.data;
  },

  async getProjects(params: ListPerformanceProjectsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: PerformanceProject[]; meta: PaginationMeta }>>(
      `${PERFORMANCE_BASE}/projects`,
      { params }
    );
    return data.data;
  },

  async getEmployees(params: ListPerformanceEmployeesParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: PerformanceEmployee[]; meta: PaginationMeta }>>(
      `${PERFORMANCE_BASE}/employees`,
      { params }
    );
    return data.data;
  },

  async getEvents(params: ListPerformanceEventsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: PerformanceEvent[] }>>(
      `${PERFORMANCE_BASE}/events`,
      { params }
    );
    return data.data;
  },

  async createEvent(payload: CreatePerformanceEventPayload) {
    const { data } = await api.post<ApiEnvelope<{ id: string }>>(`${PERFORMANCE_BASE}/events`, payload);
    return data.data;
  },

  async getEvent(id: string) {
    const { data } = await api.get<ApiEnvelope<PerformanceEvent>>(`${PERFORMANCE_BASE}/events/${id}`);
    return data.data;
  },
};

export const hiringService = {
  async getStats() {
    const { data } = await api.get<ApiEnvelope<HiringStats>>(`${HIRING_BASE}/stats`);
    return data.data;
  },

  async listVacancies(params: ListVacanciesParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: HiringVacancy[]; meta: PaginationMeta }>>(
      `${HIRING_BASE}/vacancies`,
      { params }
    );
    return data.data;
  },

  async createVacancy(payload: CreateVacancyPayload) {
    const { data } = await api.post<ApiEnvelope<{ id: string }>>(`${HIRING_BASE}/vacancies`, payload);
    return data.data;
  },

  async getVacancy(id: string) {
    const { data } = await api.get<ApiEnvelope<HiringVacancyDetail>>(`${HIRING_BASE}/vacancies/${id}`);
    return data.data;
  },

  async updateVacancy(id: string, payload: UpdateVacancyPayload) {
    const { data } = await api.put<ApiEnvelope<{}>>(`${HIRING_BASE}/vacancies/${id}`, payload);
    return data.data;
  },

  async updateVacancyStatus(id: string, payload: UpdateVacancyStatusPayload) {
    const { data } = await api.patch<ApiEnvelope<{ status: VacancyStatus }>>(
      `${HIRING_BASE}/vacancies/${id}/status`,
      payload
    );
    return data.data;
  },

  async deleteVacancy(id: string) {
    await api.delete(`${HIRING_BASE}/vacancies/${id}`);
  },

  async listApplicants(vacancyId: string, params: ListApplicantsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: HiringApplicant[]; meta: PaginationMeta }>>(
      `${HIRING_BASE}/vacancies/${vacancyId}/applicants`,
      { params }
    );
    return data.data;
  },

  async getApplicant(id: string) {
    const { data } = await api.get<ApiEnvelope<HiringApplicantDetail>>(`${HIRING_BASE}/applicants/${id}`);
    return data.data;
  },

  async updateApplicantStage(id: string, payload: UpdateApplicantStagePayload) {
    const { data } = await api.patch<ApiEnvelope<{ stage: ApplicantStage }>>(
      `${HIRING_BASE}/applicants/${id}/stage`,
      payload
    );
    return data.data;
  },
};

export const payrollService = {
  async getStats() {
    const { data } = await api.get<ApiEnvelope<PayrollStats>>(`${PAYROLL_BASE}/stats`);
    return data.data;
  },

  async listPayroll(params: ListPayrollParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: PayrollRecord[]; meta: PaginationMeta }>>(
      PAYROLL_BASE,
      { params }
    );
    return data.data;
  },

  async listPayslips(params: ListPayslipsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: PayslipRecord[]; meta: PaginationMeta }>>(
      `${PAYROLL_BASE}/payslips`,
      { params }
    );
    return data.data;
  },

  async listReceipts(params: ListReceiptsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: ReceiptRecord[]; meta: PaginationMeta }>>(
      `${PAYROLL_BASE}/receipts`,
      { params }
    );
    return data.data;
  },

  async listDeductions(params: ListDeductionsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: DeductionRecord[]; meta: PaginationMeta }>>(
      `${PAYROLL_BASE}/deductions`,
      { params }
    );
    return data.data;
  },

  async listInvoices(params: ListInvoicesParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: InvoiceRecord[]; meta: PaginationMeta }>>(
      `${PAYROLL_BASE}/invoices`,
      { params }
    );
    return data.data;
  },

  async getEmployeePayroll(employeeId: string, year?: number) {
    const { data } = await api.get<ApiEnvelope<EmployeePayroll>>(
      `${PAYROLL_BASE}/${employeeId}`,
      { params: year ? { year } : {} }
    );
    return data.data;
  },

  async getEmployeePayslips(employeeId: string, params: ListPayslipsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: PayslipRecord[]; meta: PaginationMeta }>>(
      `${PAYROLL_BASE}/${employeeId}/payslips`,
      { params }
    );
    return data.data;
  },

  async getPayslipDetail(employeeId: string, payslipId: string) {
    const { data } = await api.get<ApiEnvelope<PayslipDetail>>(
      `${PAYROLL_BASE}/${employeeId}/payslips/${payslipId}`
    );
    return data.data;
  },

  async getEmployeeReceipts(employeeId: string, params: ListReceiptsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: ReceiptRecord[]; meta: PaginationMeta }>>(
      `${PAYROLL_BASE}/${employeeId}/receipts`,
      { params }
    );
    return data.data;
  },

  async getEmployeeDeductions(employeeId: string, params: ListDeductionsParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: DeductionRecord[]; meta: PaginationMeta }>>(
      `${PAYROLL_BASE}/${employeeId}/deductions`,
      { params }
    );
    return data.data;
  },

  async getEmployeeInvoices(employeeId: string, params: ListInvoicesParams = {}) {
    const { data } = await api.get<ApiEnvelope<{ data: InvoiceRecord[]; meta: PaginationMeta }>>(
      `${PAYROLL_BASE}/${employeeId}/invoices`,
      { params }
    );
    return data.data;
  },

  async updatePayroll(employeeId: string, payload: UpdatePayrollPayload) {
    const { data } = await api.put<ApiEnvelope<EmployeePayroll['payroll']>>(
      `${PAYROLL_BASE}/${employeeId}`,
      payload
    );
    return data.data;
  },

  async downloadReport(params: DownloadPayrollReportParams = {}) {
    const response = await api.get(`${PAYROLL_BASE}/report/download`, {
      params,
      responseType: "blob",
    });
    return response.data as Blob;
  },
};

// ─── SECTION GRANTS ──────────────────────────────────────────────────────

export const grantsService = {
  async getUserGrants(userId: string) {
    const { data } = await api.get<ApiEnvelope<SectionGrant[]>>(
      `${ACCOUNTS_BASE}/${userId}/grants`
    );
    return data.data;
  },

  async addGrant(userId: string, payload: CreateSectionGrantPayload) {
    const { data } = await api.post<ApiEnvelope<SectionGrant>>(
      `${ACCOUNTS_BASE}/${userId}/grants`,
      payload
    );
    return data.data;
  },

  // ✅ FIXED: Uses ACCOUNTS_BASE (which is /api/hrm/accounts)
  async removeGrant(grantId: string) {
    await api.delete(`${ACCOUNTS_BASE}/grants/${grantId}`);
  },

  async updateGrant(grantId: string, payload: Partial<CreateSectionGrantPayload>) {
    const { data } = await api.put<ApiEnvelope<SectionGrant>>(
      `${ACCOUNTS_BASE}/grants/${grantId}`,
      payload
    );
    return data.data;
  },

  async syncGrants(userId: string, grants: CreateSectionGrantPayload[]) {
    const { data } = await api.put<ApiEnvelope<SectionGrant[]>>(
      `${ACCOUNTS_BASE}/${userId}/grants/sync`,
      { grants }
    );
    return data.data;
  },

  async getAvailableModules() {
    const { data } = await api.get<ApiEnvelope<{
      modules: Record<string, string[]>;
    }>>(`${ACCOUNTS_BASE}/modules/available`);
    return data.data;
  },
};