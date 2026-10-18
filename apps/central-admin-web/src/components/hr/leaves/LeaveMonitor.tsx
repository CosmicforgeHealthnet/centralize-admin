"use client";

import Image from "next/image";
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";

export default function LeaveMonitor({
  employeeId,
  onBack,
  onViewHistory,
}: {
  employeeId: string;
  onBack: () => void;
  onViewHistory: () => void;
}) {
  const selectedLeave = useHrmStore((s) => s.selectedLeave);
  const employeeLeaveBalance = useHrmStore((s) => s.employeeLeaveBalance);
  const isLoadingEmployeeLeaveBalance = useHrmStore((s) => s.isLoadingEmployeeLeaveBalance);
  const leavesError = useHrmStore((s) => s.leavesError);
  const fetchEmployeeLeaveBalance = useHrmStore((s) => s.fetchEmployeeLeaveBalance);

  useEffect(() => {
    if (employeeId) fetchEmployeeLeaveBalance(employeeId);
  }, [employeeId, fetchEmployeeLeaveBalance]);

  const emp = selectedLeave?.employee;

  return (
    <div className="flex flex-col gap-4">
      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Go Back</span>
      </button>

      {/* Layout */}
      <div className="flex flex-col md:flex-row gap-4 items-start">
        {emp && (
          <div className="flex flex-col gap-3 w-full md:w-[175px] md:shrink-0">
            <div className="w-full md:w-[175px] h-[180px] rounded-xl overflow-hidden bg-muted flex items-center justify-center">
              {emp.avatarUrl ? (
                <Image src={emp.avatarUrl} alt={emp.name || ""} width={175} height={180} className="object-cover w-full h-full" />
              ) : (
                <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                  <span className="text-[40px] font-poppins font-bold text-primary">{emp.name?.charAt(0) || "?"}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Right content */}
        <div className="flex-1 min-w-0 w-full flex flex-col gap-4">
          {/* Header */}
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-poppins text-[14px] font-semibold text-foreground">Leave Monitor</h2>
            <button
              onClick={onViewHistory}
              className="h-[32px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors"
            >
              Leave History
            </button>
          </div>

          {isLoadingEmployeeLeaveBalance && (
            <div className="font-poppins text-[12px] text-muted-foreground">Loading balance…</div>
          )}
          {!isLoadingEmployeeLeaveBalance && leavesError && (
            <div className="font-poppins text-[12px] text-destructive">{leavesError}</div>
          )}
          {!isLoadingEmployeeLeaveBalance && !leavesError && employeeLeaveBalance.length === 0 && (
            <div className="font-poppins text-[12px] text-muted-foreground">No leave balance records found.</div>
          )}

          {/* Leave type cards */}
          {employeeLeaveBalance.map((leave) => (
            <div key={leave.leaveType} className="flex flex-col gap-2">
              <h3 className="font-poppins text-[13px] font-semibold text-foreground">{leave.leaveType}</h3>
              <div className="rounded-xl border border-border overflow-hidden">
                <div className="grid grid-cols-2 divide-x divide-border">
                  <div className="p-4 bg-card">
                    <p className="font-poppins text-[11px] text-muted-foreground mb-1">Available Days</p>
                    <p className="font-poppins text-[16px] font-bold text-foreground">{leave.availableDays} Days</p>
                  </div>
                  <div className="p-4 bg-card">
                    <p className="font-poppins text-[11px] text-muted-foreground mb-1">Used Days</p>
                    <p className="font-poppins text-[16px] font-bold text-foreground">{leave.usedDays} Days</p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}