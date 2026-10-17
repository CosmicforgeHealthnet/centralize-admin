"use client";
import type { AdminChartTooltipProps } from "@/types/chart-tooltip.types";

import Image from "next/image";
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, CreditCard, Phone, Mail, Calendar, Briefcase, MapPin, Users, Pencil } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import PayslipModal from "./PayslipModal";
import { useHrmStore } from "@/stores/hrm.store";
import type { PayslipRecord, ReceiptRecord, DeductionRecord, InvoiceRecord, EmployeePayroll } from "@/types/hrm.types";

type PayrollDisplayEmployee = EmployeePayroll["employee"] & { employmentCategory?: string; employmentDate?: string; phone?: string; position?: string; location?: string; headOfDepartment?: string };

type QuickAction = "overview" | "invoice" | "deductions" | "receipts" | "payslips";

const STATUS_PAID_STYLE = { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" };
const STATUS_OK_STYLE = { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" };

function CustomTooltip({ active, payload, label }: AdminChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
      <p className="font-poppins text-[11px] text-muted-foreground mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.fill }} />
          <span className="font-poppins text-[11px] text-foreground">{p.name}: {p.value}%</span>
        </div>
      ))}
    </div>
  );
}

function TableWrapper({ title, downloadLabel, children }: { title: string; downloadLabel: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-poppins text-[14px] font-semibold text-foreground">{title}</h3>
        <button className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors h-[36px] shrink-0">
          {downloadLabel}
        </button>
      </div>
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">{children}</div>
      </div>
    </div>
  );
}

function PayslipsTable({ payslips, onViewSlip }: { payslips: Array<PayslipRecord & { status?: string }>; onViewSlip: (id: string) => void }) {
  return (
    <TableWrapper title="Payslips History" downloadLabel="Download Payslips Report">
      <table className="w-full min-w-[700px]">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {["EMPLOYEE ID", "EMPLOYEE EARNINGS", "ALLOWANCE", "NET PAY", "DATE", "STATUS", "ACTION"].map((h) => (
              <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {payslips.map((row, i) => (
            <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">{row.adminUserId || "—"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">${row.netPay?.toFixed(2) || "0.00"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">—</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">${row.netPay?.toFixed(2) || "0.00"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.paymentDate || "—"}</td>
              <td className="py-2.5 px-4">
                <span className="font-poppins text-[11px] font-semibold" style={{ color: STATUS_PAID_STYLE.text }}>{row.status}</span>
              </td>
              <td className="py-2.5 px-4">
                <button onClick={() => onViewSlip(row.id)} className="text-muted-foreground hover:text-foreground transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrapper>
  );
}

function ReceiptsTable({ receipts }: { receipts: ReceiptRecord[] }) {
  return (
    <TableWrapper title="Receipt History" downloadLabel="Download Receipt Report">
      <table className="w-full min-w-[900px]">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {["INVOICE ID", "EMPLOYEE ID", "TRANSACTION ID", "BANK NAME", "MODE OF PAYMENT", "DATE", "EARNINGS", "STATUS", "ACTION"].map((h) => (
              <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {receipts.map((row, i) => (
            <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">{row.id}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">{row.adminUserId || "—"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">—</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">—</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">—</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.createdAt || "—"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">${row.amount?.toFixed(2) || "0.00"}</td>
              <td className="py-2.5 px-4">
                <span className="font-poppins text-[11px] font-semibold" style={{ color: STATUS_PAID_STYLE.text }}>PAID</span>
              </td>
              <td className="py-2.5 px-4">
                <button className="text-muted-foreground hover:text-foreground transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrapper>
  );
}

function DeductionsTable({ deductions }: { deductions: DeductionRecord[] }) {
  return (
    <TableWrapper title="Deduction History" downloadLabel="Download Deduction Report">
      <table className="w-full min-w-[800px]">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {["EMPLOYEE ID", "TOTAL DEDUCTION", "DESCRIPTION", "DATE", "EARNINGS", "NET PAY", "STATUS", "ACTION"].map((h) => (
              <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {deductions.map((row, i) => (
            <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">{row.adminUserId || "—"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">${row.amount?.toFixed(2) || "0.00"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">{row.deductionName || "—"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.month}/{row.year}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">—</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">—</td>
              <td className="py-2.5 px-4">
                <span className="font-poppins text-[11px] font-semibold" style={{ color: STATUS_OK_STYLE.text }}>SUCCESSFUL</span>
              </td>
              <td className="py-2.5 px-4">
                <button className="text-muted-foreground hover:text-foreground transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrapper>
  );
}

function InvoiceTable({ invoices }: { invoices: InvoiceRecord[] }) {
  return (
    <TableWrapper title="Invoice History" downloadLabel="Download Invoice Report">
      <table className="w-full min-w-[800px]">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {["INVOICE ID", "EMPLOYEE ID", "BANK NAME", "MODE OF PAYMENT", "DATE", "EARNINGS", "STATUS", "ACTION"].map((h) => (
              <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {invoices.map((row, i) => (
            <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">{row.id}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">{row.adminUserId || "—"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">—</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">—</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.dueDate || "—"}</td>
              <td className="py-2.5 px-4 font-poppins text-[12px] text-foreground">${row.amount?.toFixed(2) || "0.00"}</td>
              <td className="py-2.5 px-4">
                <span className="font-poppins text-[11px] font-semibold" style={{ color: STATUS_PAID_STYLE.text }}>{row.status}</span>
              </td>
              <td className="py-2.5 px-4">
                <button className="text-muted-foreground hover:text-foreground transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrapper>
  );
}

function LeftPanelSkeleton() {
  return (
    <div className="flex flex-col gap-3 w-full md:w-[200px] md:shrink-0 animate-pulse">
      <div className="w-full md:w-[200px] h-[180px] rounded-xl bg-muted" />
      <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2.5">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="w-3.5 h-3.5 bg-muted rounded" />
            <div className="flex flex-col gap-1 flex-1">
              <div className="h-3 w-16 bg-muted rounded" />
              <div className="h-4 w-24 bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewContentSkeleton() {
  return (
    <div className="flex flex-col gap-4 animate-pulse">
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="h-5 w-32 bg-muted rounded" />
          <div className="h-4 w-4 bg-muted rounded" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <div className="h-3 w-16 bg-muted rounded" />
              <div className="h-4 w-20 bg-muted rounded" />
            </div>
          ))}
        </div>
      </div>
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="h-[220px] bg-muted rounded" />
      </div>
    </div>
  );
}

function OverviewContent({ emp, payroll, chartData }: { emp: PayrollDisplayEmployee | undefined; payroll: EmployeePayroll["payroll"] | undefined; chartData: EmployeePayroll["chartData"] }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Profile Details</h3>
          <button className="text-muted-foreground hover:text-primary transition-colors">
            <Pencil className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-3">
          {[
            { label: "Full Name:", value: emp?.name || "—" },
            { label: "Department:", value: emp?.department || "—" },
            { label: "Employment Type:", value: emp?.employmentType || "—" },
            { label: "Employment Category:", value: emp?.employmentCategory || "—" },
            { label: "Employment Date:", value: emp?.employmentDate || "—" },
            { label: "Total Salary:", value: payroll ? `$${payroll.totalSalary?.toFixed(2) || "0.00"}` : "—" },
            { label: "Total Bonus:", value: payroll ? `$${payroll.bonus?.toFixed(2) || "0.00"}` : "—" },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
              <span className="font-poppins text-[12px] font-semibold text-foreground">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
          <div>
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">Employee Payroll Overview</h3>
            <p className="font-poppins text-[11px] text-muted-foreground">January-Till date</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm border-2 border-muted-foreground/40" />
                <span className="font-poppins text-[11px] text-muted-foreground">Net Salary</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-primary" />
                <span className="font-poppins text-[11px] text-muted-foreground">Deductions</span>
              </div>
            </div>
            <button className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors">
              Download Report <ChevronDown className="w-3 h-3" />
            </button>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} barSize={14} barGap={2} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(39,46,167,0.04)" }} />
            <Bar dataKey="netPay" name="Net Salary" fill="rgba(39,46,167,0.15)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {payroll && (
        <>
          <div className="bg-card rounded-xl border border-border p-4">
            <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-0.5">Payment Information</h3>
            <p className="font-poppins text-[11px] text-muted-foreground mb-3">Employee Payment Information</p>
            <div className="flex flex-col gap-2.5">
              <div className="flex items-start gap-2">
                <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1" />
                <div>
                  <span className="font-poppins text-[12px] font-semibold text-foreground">Payment Method: </span>
                  <span className="font-poppins text-[12px] text-foreground">{payroll.paymentMethod || "Bank Transfer"}</span>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1" />
                <div>
                  <span className="font-poppins text-[12px] font-semibold text-foreground">Bank Account Details: </span>
                  <span className="font-poppins text-[12px] text-foreground">{payroll.bankName || "—"} {payroll.bankAccount || ""}</span>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1" />
                <div>
                  <span className="font-poppins text-[12px] font-semibold text-foreground">Date of Last Disbursement: </span>
                  <span className="font-poppins text-[12px] text-foreground">{payroll.paymentDate || "—"}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-poppins text-[13px] font-semibold text-foreground">Payroll List</h3>
                <p className="font-poppins text-[11px] text-muted-foreground">Employee Payroll List</p>
              </div>
              <button className="flex items-center gap-1 text-[12px] font-poppins text-muted-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer">
                August <ChevronDown className="w-3 h-3" />
              </button>
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#0DA53F" }} />
                  <span className="font-poppins text-[12px] font-semibold text-foreground">Total Salary:</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-poppins text-[12px] text-foreground">${payroll.totalSalary?.toFixed(2) || "0.00"}</span>
                  <button className="text-muted-foreground hover:text-primary transition-colors">
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#272EA7" }} />
                  <span className="font-poppins text-[12px] font-semibold text-foreground">Total Allowance:</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-poppins text-[12px] text-foreground">${payroll.allowance?.toFixed(2) || "0.00"}</span>
                  <button className="text-muted-foreground hover:text-primary transition-colors">
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#F59E0B" }} />
                  <span className="font-poppins text-[12px] font-semibold text-foreground">Total Bonus:</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-poppins text-[12px] text-foreground">${payroll.bonus?.toFixed(2) || "0.00"}</span>
                  <button className="text-muted-foreground hover:text-primary transition-colors">
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#EF4444" }} />
                  <span className="font-poppins text-[12px] font-semibold text-foreground">Total Deductions:</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-poppins text-[12px] text-foreground">${payroll.deductions?.toFixed(2) || "0.00"}</span>
                  <button className="text-muted-foreground hover:text-primary transition-colors">
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-border flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="font-poppins text-[12px] text-muted-foreground">Status:</span>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-semibold"
                  style={{ backgroundColor: "rgba(13,165,63,0.12)", color: "#0DA53F" }}>
                  {payroll.status}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#F59E0B" }} />
                <span className="font-poppins text-[12px] font-semibold text-foreground">Gross Pay: </span>
                <span className="font-poppins text-[12px] text-foreground">${payroll.grossPay?.toFixed(2) || "0.00"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#0DA53F" }} />
                <span className="font-poppins text-[12px] font-semibold text-foreground">Net Pay: </span>
                <span className="font-poppins text-[12px] text-foreground">${payroll.netPay?.toFixed(2) || "0.00"}</span>
              </div>
              <p className="font-poppins text-[11px] text-primary mt-1">Payment Date: {payroll.paymentDate || "—"}</p>
            </div>

            <div className="mt-3 h-2 rounded-full overflow-hidden flex">
              <div className="h-full bg-green-500" style={{ width: "40%" }} />
              <div className="h-full bg-yellow-400" style={{ width: "25%" }} />
              <div className="h-full bg-orange-400" style={{ width: "20%" }} />
              <div className="h-full bg-red-500" style={{ width: "15%" }} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LeftPanel({
  emp,
  activeAction,
  onActionChange,
}: {
  emp: PayrollDisplayEmployee | undefined;
  activeAction: QuickAction;
  onActionChange: (a: QuickAction) => void;
}) {
  const QUICK_ACTIONS: { id: QuickAction; label: string; color: string }[] = [
    { id: "invoice", label: "Invoice", color: "#F59E0B" },
    { id: "deductions", label: "Deductions", color: "#EF4444" },
    { id: "receipts", label: "Receipts", color: "#8B5CF6" },
    { id: "payslips", label: "Payslips", color: "#0DA53F" },
  ];

  return (
    <div className="flex flex-col gap-3 w-full md:w-[200px] md:shrink-0">
      <div className="w-full md:w-[200px] h-[180px] rounded-xl overflow-hidden bg-muted flex items-center justify-center">
        {emp?.avatarUrl ? (
          <Image src={emp.avatarUrl} alt={emp.name} width={200} height={180} className="object-cover w-full h-full" />
        ) : (
          <div className="w-full h-full bg-primary/10 flex items-center justify-center">
            <span className="text-[40px] font-poppins font-bold text-primary">{emp?.name?.charAt(0) || "?"}</span>
          </div>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2.5">
        {[
          { icon: <CreditCard className="w-3.5 h-3.5" />, label: "Employee ID:", value: emp?.employeeCode || "—" },
          { icon: <Phone className="w-3.5 h-3.5" />, label: "Phone Number:", value: emp?.phone || "—" },
          { icon: <Mail className="w-3.5 h-3.5" />, label: "Email Address:", value: emp?.email || "—" },
          { icon: <Calendar className="w-3.5 h-3.5" />, label: "Employment Date:", value: emp?.employmentDate || "—" },
          { icon: <Briefcase className="w-3.5 h-3.5" />, label: "Position:", value: emp?.position || "—" },
          { icon: <MapPin className="w-3.5 h-3.5" />, label: "Location:", value: emp?.location || "—" },
          { icon: <Users className="w-3.5 h-3.5" />, label: "Head of Department:", value: emp?.headOfDepartment || "—" },
        ].map(({ icon, label, value }) => (
          <div key={label} className="flex items-start gap-2">
            <span className="text-muted-foreground shrink-0 mt-0.5">{icon}</span>
            <div className="flex flex-col min-w-0">
              <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
              <span className="font-poppins text-[11px] font-semibold text-foreground break-words">{value}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-card rounded-xl border border-border p-3">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground mb-2.5">Quick Actions</h3>
        <div className="flex flex-col gap-1.5">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.id}
              onClick={() => onActionChange(action.id)}
              className={`flex items-center gap-2.5 px-2 py-2 rounded-lg transition-colors w-full text-left ${
                activeAction === action.id ? "bg-muted" : "hover:bg-muted/50"
              }`}
            >
              <span
                className="w-6 h-6 rounded-full flex items-center justify-center text-white font-poppins font-bold text-[11px] shrink-0"
                style={{ backgroundColor: action.color }}
              >
                {action.label.charAt(0)}
              </span>
              <span className="font-poppins text-[12px] text-foreground">{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function PayrollEmployeeDetail({ employeeId, onBack }: { employeeId: string; onBack: () => void }) {
  const [activeAction, setActiveAction] = useState<QuickAction>("overview");
  const [showPayslip, setShowPayslip] = useState(false);
  const [selectedPayslipId, setSelectedPayslipId] = useState<string | null>(null);

  const {
    selectedEmployeePayroll,
    isLoadingEmployeePayroll,
    payslips,
    isLoadingPayslips,
    receipts,
    isLoadingReceipts,
    deductions,
    isLoadingDeductions,
    invoices,
    isLoadingInvoices,
    payrollError,
    fetchEmployeePayroll,
    clearEmployeePayroll,
    fetchEmployeePayslips,
    clearEmployeePayslips,
    fetchEmployeeReceipts,
    clearEmployeeReceipts,
    fetchEmployeeDeductions,
    clearEmployeeDeductions,
    fetchEmployeeInvoices,
    clearEmployeeInvoices,
    fetchPayslipDetail,
    clearSelectedPayslip,
  } = useHrmStore();

  useEffect(() => {
    fetchEmployeePayroll(employeeId);
    fetchEmployeePayslips(employeeId);
    fetchEmployeeReceipts(employeeId);
    fetchEmployeeDeductions(employeeId);
    fetchEmployeeInvoices(employeeId);

    return () => {
      clearEmployeePayroll();
      clearEmployeePayslips();
      clearEmployeeReceipts();
      clearEmployeeDeductions();
      clearEmployeeInvoices();
      clearSelectedPayslip();
    };
  }, [employeeId]);

  const emp = selectedEmployeePayroll?.employee;
  const payroll = selectedEmployeePayroll?.payroll;
  const chartData = selectedEmployeePayroll?.chartData || [];

  const handleViewSlip = (id: string) => {
    setSelectedPayslipId(id);
    fetchPayslipDetail(employeeId, id);
    setShowPayslip(true);
  };

  const renderContent = () => {
    if (isLoadingEmployeePayroll && !emp) {
      return <OverviewContentSkeleton />;
    }

    switch (activeAction) {
      case "overview":
        return <OverviewContent emp={emp} payroll={payroll} chartData={chartData} />;
      case "payslips":
        return isLoadingPayslips ? (
          <div className="h-40 flex items-center justify-center"><span className="text-muted-foreground">Loading...</span></div>
        ) : (
          <PayslipsTable payslips={payslips} onViewSlip={handleViewSlip} />
        );
      case "receipts":
        return isLoadingReceipts ? (
          <div className="h-40 flex items-center justify-center"><span className="text-muted-foreground">Loading...</span></div>
        ) : (
          <ReceiptsTable receipts={receipts} />
        );
      case "deductions":
        return isLoadingDeductions ? (
          <div className="h-40 flex items-center justify-center"><span className="text-muted-foreground">Loading...</span></div>
        ) : (
          <DeductionsTable deductions={deductions} />
        );
      case "invoice":
        return isLoadingInvoices ? (
          <div className="h-40 flex items-center justify-center"><span className="text-muted-foreground">Loading...</span></div>
        ) : (
          <InvoiceTable invoices={invoices} />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Go Back</span>
      </button>

      <h2 className="font-poppins text-[14px] font-semibold text-foreground">Employee Payroll</h2>

      {payrollError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {payrollError}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4 items-start">
        {isLoadingEmployeePayroll && !emp ? (
          <LeftPanelSkeleton />
        ) : (
          <LeftPanel emp={emp} activeAction={activeAction} onActionChange={setActiveAction} />
        )}
        <div className="flex-1 min-w-0 w-full">{renderContent()}</div>
      </div>

      {showPayslip && (
        <PayslipModal
          onClose={() => {
            setShowPayslip(false);
            setSelectedPayslipId(null);
            clearSelectedPayslip();
          }}
        />
      )}
    </div>
  );
}