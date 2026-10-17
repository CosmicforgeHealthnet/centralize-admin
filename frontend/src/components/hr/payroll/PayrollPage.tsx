"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, TrendingUp, TrendingDown } from "lucide-react";
import PayrollEmployeeDetail from "./PayrollEmployeeDetail";
import { useHrmStore } from "@/stores/hrm.store";
import { PayrollStatus } from "@/types/hrm.types";

type PayrollTab = "overview" | "payslips" | "receipts" | "deductions" | "invoice";

function StatCardSkeleton() {
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex items-center gap-3 animate-pulse">
      <div className="w-10 h-10 rounded-lg bg-muted" />
      <div className="flex flex-col gap-1 flex-1">
        <div className="h-3 w-20 bg-muted rounded" />
        <div className="h-6 w-16 bg-muted rounded" />
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 bg-muted rounded-full" />
          <div className="h-3 w-12 bg-muted rounded" />
        </div>
      </div>
    </div>
  );
}

function StatCard({ card, isLoading }: { card: any; isLoading: boolean }) {
  const isUp = card.trend === "up";
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
        <StatIcon type={card.icon} />
      </div>
      <div className="flex flex-col min-w-0">
        <span className="font-poppins text-[11px] font-medium text-muted-foreground truncate">{card.label}</span>
        <span className="font-poppins text-[22px] font-bold text-foreground leading-tight">
          {isLoading ? "..." : card.value}
        </span>
        <div className="flex items-center gap-1 flex-wrap">
          {isUp
            ? <TrendingUp className="w-3 h-3 text-green-500 shrink-0" />
            : <TrendingDown className="w-3 h-3 text-red-500 shrink-0" />
          }
          <span className={`font-poppins text-[10px] font-semibold ${isUp ? "text-green-500" : "text-red-500"}`}>
            {card.change}
          </span>
          <span className="font-poppins text-[10px] text-muted-foreground">{card.subtitle}</span>
        </div>
      </div>
    </div>
  );
}

function StatIcon({ type }: { type: string }) {
  const cls = "w-5 h-5 text-primary";
  if (type === "users") return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
  if (type === "pending") return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  );
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="5" width="20" height="14" rx="2"/>
      <line x1="2" y1="10" x2="22" y2="10"/>
    </svg>
  );
}

function PayrollRowSkeleton() {
  return (
    <tr className="border-b border-border/50 animate-pulse">
      <td className="py-3 px-4"><div className="flex items-center gap-2.5"><div className="w-8 h-8 rounded-full bg-muted" /><div><div className="h-4 w-32 bg-muted rounded" /><div className="h-3 w-24 bg-muted rounded mt-1" /></div></div></td>
      <td className="py-3 px-4"><div className="h-4 w-20 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-24 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-28 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-20 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-16 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-6 w-16 bg-muted rounded-full" /></td>
      <td className="py-3 px-4"><div className="flex gap-2"><div className="h-4 w-4 bg-muted rounded" /><div className="h-4 w-4 bg-muted rounded" /></div></td>
    </tr>
  );
}

function HistoryRowSkeleton() {
  return (
    <tr className="border-b border-border/50 animate-pulse">
      <td className="py-3 px-4"><div className="h-4 w-32 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-20 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-24 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-16 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-20 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-4 w-24 bg-muted rounded" /></td>
      <td className="py-3 px-4"><div className="h-6 w-16 bg-muted rounded-full" /></td>
      <td className="py-3 px-4"><div className="h-4 w-4 bg-muted rounded" /></td>
    </tr>
  );
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  PAID: { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
  PENDING: { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  Paid: { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
  Pending: { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
};

const TABS: { id: PayrollTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "payslips", label: "Payslips" },
  { id: "receipts", label: "Receipts" },
  { id: "deductions", label: "Deduction" },
  { id: "invoice", label: "Invoice" },
];

export default function PayrollPage() {
  const [activeTab, setActiveTab] = useState<PayrollTab>("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    payrollStats,
    isLoadingPayrollStats,
    payrollRecords,
    payrollMeta,
    isLoadingPayroll,
    payslips,
    payslipsMeta,
    isLoadingPayslips,
    receipts,
    receiptsMeta,
    isLoadingReceipts,
    deductions,
    deductionsMeta,
    isLoadingDeductions,
    invoices,
    invoicesMeta,
    isLoadingInvoices,
    payrollError,
    fetchPayrollStats,
    fetchPayroll,
    fetchPayslips,
    fetchReceipts,
    fetchDeductions,
    fetchInvoices,
    setPayrollFilters,
    setPayslipsFilters,
    setReceiptsFilters,
    setDeductionsFilters,
    setInvoicesFilters,
  } = useHrmStore();

  useEffect(() => {
    fetchPayrollStats();
    fetchPayroll();
    fetchPayslips();
    fetchReceipts();
    fetchDeductions();
    fetchInvoices();
  }, []);

  if (selectedId) {
    return <PayrollEmployeeDetail employeeId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  const stats = payrollStats;
  const statCards = [
    {
      label: "Total Employees",
      value: stats?.totalEmployees || 0,
      change: `${stats?.changes?.employeesChange || 0}%`,
      trend: (stats?.changes?.employeesChange || 0) >= 0 ? "up" : "down",
      subtitle: "from last month",
      icon: "users",
    },
    {
      label: "Total Payroll",
      value: `$${stats?.totalPayroll?.toLocaleString() || 0}`,
      change: `${stats?.changes?.totalPayrollChange || 0}%`,
      trend: (stats?.changes?.totalPayrollChange || 0) >= 0 ? "up" : "down",
      subtitle: "from last month",
      icon: "money",
    },
    {
      label: "Pending Payroll",
      value: stats?.pendingPayroll || 0,
      change: `${stats?.changes?.pendingPayrollChange || 0}%`,
      trend: (stats?.changes?.pendingPayrollChange || 0) >= 0 ? "up" : "down",
      subtitle: "from last month",
      icon: "pending",
    },
    {
      label: "Paid Payroll",
      value: stats?.paidPayroll || 0,
      change: `${stats?.changes?.paidPayrollChange || 0}%`,
      trend: (stats?.changes?.paidPayrollChange || 0) >= 0 ? "up" : "down",
      subtitle: "from last month",
      icon: "paid",
    },
  ];

  const renderOverview = () => {
    const currentPage = payrollMeta?.page || 1;
    const totalPages = payrollMeta?.totalPages || 1;

    return (
      <div className="bg-card rounded-xl border border-border flex flex-col">
        {payrollError && (
          <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-red-700 text-sm">
            {payrollError}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {["Employee Name", "Employee ID", "Employment Type", "Department", "Designation", "Net Pay", "Status", "Action"].map((h) => (
                  <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoadingPayroll ? (
                Array.from({ length: 5 }).map((_, i) => <PayrollRowSkeleton key={i} />)
              ) : payrollRecords.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-muted-foreground">No payroll records found</td></tr>
              ) : (
                payrollRecords.map((emp) => {
                  const st = STATUS_STYLES[emp.status] || STATUS_STYLES["PAID"];
                  return (
                    <tr key={emp.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
                      onClick={() => setSelectedId(emp.adminUserId)}>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-muted">
                            {emp.avatarUrl ? (
                              <Image src={emp.avatarUrl} alt={emp.name || ""} width={32} height={32} className="object-cover w-full h-full" />
                            ) : (
                              <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                                <span className="text-[12px] font-poppins font-bold text-primary">{emp.name?.charAt(0) || "?"}</span>
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col min-w-0">
                            <span className="font-poppins text-[12px] font-semibold text-foreground truncate">{emp.name || "Unknown"}</span>
                            <span className="font-poppins text-[10px] text-muted-foreground truncate">{emp.email || ""}</span>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{emp.employeeCode || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{emp.employmentType || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{emp.department || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{emp.designation || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">${emp.netPay?.toFixed(2) || "0.00"}</td>
                      <td className="py-3 px-4">
                        <span className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap"
                          style={{ backgroundColor: st.bg, color: st.text }}>
                          {emp.status}
                        </span>
                      </td>
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2.5">
                          <button title="Edit" className="text-muted-foreground hover:text-primary transition-colors"
                            onClick={() => setSelectedId(emp.adminUserId)}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-1 px-4 py-4 flex-wrap">
            <button onClick={() => setPayrollFilters({ page: currentPage - 1 })} disabled={currentPage <= 1}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-4 h-4 text-foreground" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button key={p} onClick={() => setPayrollFilters({ page: p })}
                className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                  currentPage === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
                }`}>{p}</button>
            ))}
            <button onClick={() => setPayrollFilters({ page: currentPage + 1 })} disabled={currentPage >= totalPages}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronRight className="w-4 h-4 text-foreground" />
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderHistoryTable = (
    data: any[],
    meta: any,
    isLoading: boolean,
    setPage: (page: number) => void,
    title: string,
    headers: string[],
    rowRenderer: (item: any, index: number) => React.ReactNode
  ) => {
    const currentPage = meta?.page || 1;
    const totalPages = meta?.totalPages || 1;

    return (
      <div className="bg-card rounded-xl border border-border flex flex-col">
        {payrollError && (
          <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-red-700 text-sm">
            {payrollError}
          </div>
        )}
        <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-border">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">{title}</h3>
          <button className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors h-[36px] shrink-0">
            Download Report
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[750px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {headers.map((h) => (
                  <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => <HistoryRowSkeleton key={i} />)
              ) : data.length === 0 ? (
                <tr><td colSpan={headers.length} className="text-center py-12 text-muted-foreground">No records found</td></tr>
              ) : (
                data.map((item, i) => rowRenderer(item, i))
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-1 px-4 py-4 flex-wrap">
            <button onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-4 h-4 text-foreground" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button key={p} onClick={() => setPage(p)}
                className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                  currentPage === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
                }`}>{p}</button>
            ))}
            <button onClick={() => setPage(currentPage + 1)} disabled={currentPage >= totalPages}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronRight className="w-4 h-4 text-foreground" />
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderPayslips = () => renderHistoryTable(
    payslips,
    payslipsMeta,
    isLoadingPayslips,
    (page) => setPayslipsFilters({ page }),
    "Payslips History",
    ["EMPLOYEE NAME", "EMPLOYEE ID", "EARNINGS", "ALLOWANCE", "NET PAY", "DATE", "STATUS", "ACTION"],
    (row: any, i) => {
      const st = STATUS_STYLES[row.status] || STATUS_STYLES["PAID"];
      return (
        <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{row.name || "Unknown"}</td>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.adminUserId || "—"}</td>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground">${row.netPay?.toFixed(2) || "0.00"}</td>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground">—</td>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground">${row.netPay?.toFixed(2) || "0.00"}</td>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.paymentDate || "—"}</td>
          <td className="py-3 px-4">
            <span className="font-poppins text-[11px] font-semibold" style={{ color: st.text }}>{row.status}</span>
          </td>
          <td className="py-3 px-4">
            <button className="text-muted-foreground hover:text-foreground transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
              </svg>
            </button>
          </td>
        </tr>
      );
    }
  );

  const renderReceipts = () => renderHistoryTable(
    receipts,
    receiptsMeta,
    isLoadingReceipts,
    (page) => setReceiptsFilters({ page }),
    "Receipt History",
    ["EMPLOYEE NAME", "EMPLOYEE ID", "AMOUNT", "DESCRIPTION", "DATE", "ACTION"],
    (row: any, i) => (
      <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{row.name || "Unknown"}</td>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.adminUserId || "—"}</td>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground">${row.amount?.toFixed(2) || "0.00"}</td>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{row.description || "—"}</td>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.createdAt || "—"}</td>
        <td className="py-3 px-4">
          <button className="text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
            </svg>
          </button>
        </td>
      </tr>
    )
  );

  const renderDeductions = () => renderHistoryTable(
    deductions,
    deductionsMeta,
    isLoadingDeductions,
    (page) => setDeductionsFilters({ page }),
    "Deduction History",
    ["EMPLOYEE NAME", "EMPLOYEE ID", "DEDUCTION NAME", "AMOUNT", "MONTH/YEAR", "ACTION"],
    (row: any, i) => (
      <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{row.name || "Unknown"}</td>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.adminUserId || "—"}</td>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{row.deductionName || "—"}</td>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground">${row.amount?.toFixed(2) || "0.00"}</td>
        <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.month}/{row.year}</td>
        <td className="py-3 px-4">
          <button className="text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
            </svg>
          </button>
        </td>
      </tr>
    )
  );

  const renderInvoices = () => renderHistoryTable(
    invoices,
    invoicesMeta,
    isLoadingInvoices,
    (page) => setInvoicesFilters({ page }),
    "Invoice History",
    ["EMPLOYEE NAME", "EMPLOYEE ID", "AMOUNT", "DESCRIPTION", "DUE DATE", "STATUS", "ACTION"],
    (row: any, i) => {
      const st = STATUS_STYLES[row.status] || STATUS_STYLES["PAID"];
      return (
        <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{row.name || "Unknown"}</td>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.adminUserId || "—"}</td>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground">${row.amount?.toFixed(2) || "0.00"}</td>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{row.description || "—"}</td>
          <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.dueDate || "—"}</td>
          <td className="py-3 px-4">
            <span className="font-poppins text-[11px] font-semibold" style={{ color: st.text }}>{row.status}</span>
          </td>
          <td className="py-3 px-4">
            <button className="text-muted-foreground hover:text-foreground transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
              </svg>
            </button>
          </td>
        </tr>
      );
    }
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {isLoadingPayrollStats
          ? Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
          : statCards.map((card) => <StatCard key={card.label} card={card} isLoading={false} />)
        }
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border overflow-x-auto scrollbar-none">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`relative px-5 py-2.5 font-poppins text-[13px] font-medium whitespace-nowrap transition-colors shrink-0 ${
              activeTab === tab.id ? "text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {activeTab === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-t-full" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === "overview" && renderOverview()}
      {activeTab === "payslips" && renderPayslips()}
      {activeTab === "receipts" && renderReceipts()}
      {activeTab === "deductions" && renderDeductions()}
      {activeTab === "invoice" && renderInvoices()}
    </div>
  );
}