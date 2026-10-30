"use client";

import { X } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";

interface Props {
  onClose: () => void;
}

export default function PayslipModal({ onClose }: Props) {
  const { selectedPayslip, isLoadingPayslip } = useHrmStore();

  if (isLoadingPayslip) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
        <div className="bg-white rounded-2xl w-full max-w-[600px] shadow-xl overflow-hidden p-8 text-center">
          <div className="animate-pulse flex flex-col items-center gap-4">
            <div className="h-8 w-32 bg-muted rounded" />
            <div className="h-4 w-48 bg-muted rounded" />
            <div className="h-6 w-24 bg-muted rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (!selectedPayslip) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
        <div className="bg-white rounded-2xl w-full max-w-[600px] shadow-xl overflow-hidden p-8 text-center">
          <p className="font-poppins text-muted-foreground">No payslip data</p>
          <button onClick={onClose} className="mt-4 text-primary">Close</button>
        </div>
      </div>
    );
  }

  const slip = selectedPayslip;
  const emp = slip.employee;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl w-full max-w-[600px] shadow-xl overflow-hidden">
        <div className="flex justify-end px-4 pt-3">
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-8 pb-6">
          <div className="flex items-start justify-between border-b border-gray-200 pb-3 mb-4">
            <div>
              <h1 className="font-poppins text-[20px] font-bold text-foreground">BURSARY</h1>
              <p className="font-poppins text-[12px] text-muted-foreground">Pay Slip</p>
            </div>
            <p className="font-poppins text-[12px] text-muted-foreground">Anywhere: City</p>
          </div>

          <h2 className="font-poppins text-[14px] font-semibold text-foreground mb-4">Earning Statement</h2>

          <div className="flex gap-4 mb-4">
            <div className="w-16 h-16 bg-muted rounded shrink-0 flex items-center justify-center">
              {emp?.avatarUrl ? (
                <img src={emp.avatarUrl} alt={emp.name} className="w-full h-full object-cover rounded" />
              ) : (
                <span className="text-2xl font-bold text-primary">{emp?.name?.charAt(0) || "?"}</span>
              )}
            </div>
            <div className="flex-1">
              <p className="font-poppins text-[13px] font-semibold text-foreground">{emp?.name || "Unknown"}</p>
              <p className="font-poppins text-[11px] text-muted-foreground">{emp?.department || "—"}</p>
              <p className="font-poppins text-[11px] text-muted-foreground">{emp?.designation || "—"}</p>
              <div className="mt-2 flex flex-col gap-0.5">
                <p className="font-poppins text-[11px] text-foreground"><span className="font-semibold">Department:</span> {emp?.department || "—"}</p>
                <p className="font-poppins text-[11px] text-foreground"><span className="font-semibold">Tax No:</span> —</p>
                <p className="font-poppins text-[11px] text-foreground"><span className="font-semibold">Bank Account No:</span> —</p>
              </div>
            </div>
            <div className="flex flex-col gap-1 text-right shrink-0">
              <div className="flex gap-6">
                <div>
                  <p className="font-poppins text-[10px] text-muted-foreground uppercase tracking-wide">Month</p>
                  <p className="font-poppins text-[11px] font-semibold text-foreground">{slip.month}/{slip.year}</p>
                </div>
                <div>
                  <p className="font-poppins text-[10px] text-muted-foreground uppercase tracking-wide">Date</p>
                  <p className="font-poppins text-[11px] font-semibold text-foreground">{slip.paymentDate || "—"}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-col gap-1 text-left">
                <p className="font-poppins text-[11px] text-foreground"><span className="font-semibold">Payment Method:</span> {slip.paymentMethod || "—"}</p>
                <p className="font-poppins text-[11px] text-foreground"><span className="font-semibold">Payment Date:</span> {slip.paymentDate || "—"}</p>
                <p className="font-poppins text-[11px] text-foreground"><span className="font-semibold">From Date:</span> —</p>
                <p className="font-poppins text-[11px] text-foreground"><span className="font-semibold">To Date:</span> —</p>
              </div>
            </div>
          </div>

          <div className="mb-3">
            <div className="flex items-center justify-between py-1.5 border-b border-gray-200">
              <p className="font-poppins text-[11px] font-bold text-foreground uppercase tracking-wide">Employee Earnings</p>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-dashed border-gray-200">
              <p className="font-poppins text-[11px] text-muted-foreground">Description</p>
              <p className="font-poppins text-[11px] text-muted-foreground">Duration</p>
              <p className="font-poppins text-[11px] text-muted-foreground">Rate</p>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-dashed border-gray-200">
              <p className="font-poppins text-[11px] text-foreground">Basic Salary</p>
              <p className="font-poppins text-[11px] text-foreground"></p>
              <p className="font-poppins text-[11px] text-foreground">${slip.basicSalary?.toFixed(2) || "0.00"}</p>
            </div>
          </div>

          <div className="mb-3">
            <div className="flex items-center justify-between py-1.5 border-b border-gray-200">
              <p className="font-poppins text-[11px] font-bold text-foreground uppercase tracking-wide">Allowances</p>
              <p className="font-poppins text-[11px] font-bold text-foreground uppercase tracking-wide">Rate</p>
            </div>
            <div className="grid grid-cols-2 gap-x-8">
              <div className="flex flex-col gap-1 py-1">
                {["Description", "Commission", "Bonus"].map((item) => (
                  <p key={item} className="font-poppins text-[11px] text-foreground border-b border-dashed border-gray-200 py-1">{item}</p>
                ))}
              </div>
              <div className="flex flex-col gap-1 py-1">
                {["Tax", "Loan", "Pension Savings"].map((item) => (
                  <p key={item} className="font-poppins text-[11px] text-foreground border-b border-dashed border-gray-200 py-1">{item}</p>
                ))}
              </div>
            </div>
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between py-1.5 border-b border-gray-200">
              <p className="font-poppins text-[11px] font-bold text-foreground uppercase tracking-wide">Net Salary</p>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-dashed border-gray-200">
              <p className="font-poppins text-[11px] text-muted-foreground">Description</p>
              <p className="font-poppins text-[11px] text-muted-foreground">Rate</p>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-gray-300">
              <p className="font-poppins text-[11px] text-foreground">Net Pay</p>
              <p className="font-poppins text-[11px] text-foreground">${slip.netPay?.toFixed(2) || "0.00"}</p>
            </div>
          </div>

          <div className="flex items-center justify-center gap-4">
            <button
              onClick={onClose}
              className="h-[40px] px-8 rounded-lg border border-border text-[13px] font-poppins font-semibold text-foreground hover:bg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              className="h-[40px] px-8 rounded-lg bg-primary text-white text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors"
            >
              Download & Print
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}