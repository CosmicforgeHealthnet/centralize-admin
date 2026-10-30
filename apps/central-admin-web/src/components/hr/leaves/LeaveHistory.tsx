"use client";

import Image from "next/image";
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  APPROVED: { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
  PENDING: { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  DENIED: { bg: "rgba(246,69,69,0.12)", text: "#F64545" },
};

function formatDateRange(start: string | null, end: string | null) {
  if (!start && !end) return "—";
  if (start && end) return `${start} - ${end}`;
  return start || end || "—";
}

export default function LeaveHistory({
  employeeId,
  onBack,
  onViewMonitor,
}: {
  employeeId: string;
  onBack: () => void;
  onViewMonitor: () => void;
}) {
  const selectedLeave = useHrmStore((s) => s.selectedLeave);
  const employeeLeaveHistory = useHrmStore((s) => s.employeeLeaveHistory);
  const isLoadingEmployeeLeaveHistory = useHrmStore((s) => s.isLoadingEmployeeLeaveHistory);
  const leavesError = useHrmStore((s) => s.leavesError);
  const fetchEmployeeLeaveHistory = useHrmStore((s) => s.fetchEmployeeLeaveHistory);
  const downloadLeaveReport = useHrmStore((s) => s.downloadLeaveReport);

  useEffect(() => {
    if (employeeId) fetchEmployeeLeaveHistory(employeeId);
  }, [employeeId, fetchEmployeeLeaveHistory]);

  const emp = selectedLeave?.employee;

  const handleDownload = async () => {
    const blob = await downloadLeaveReport({ employeeId });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leave-report.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

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
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-poppins text-[14px] font-semibold text-foreground">Leave History</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handleDownload}
                className="h-[32px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors"
              >
                Download Leave Report
              </button>
              <button
                onClick={onViewMonitor}
                className="h-[32px] px-4 border border-primary text-primary text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/5 transition-colors"
              >
                View Leave Monitor
              </button>
            </div>
          </div>

          {/* History list */}
          <div className="flex flex-col gap-3">
            {isLoadingEmployeeLeaveHistory && (
              <div className="font-poppins text-[12px] text-muted-foreground">Loading history…</div>
            )}
            {!isLoadingEmployeeLeaveHistory && leavesError && (
              <div className="font-poppins text-[12px] text-destructive">{leavesError}</div>
            )}
            {!isLoadingEmployeeLeaveHistory && !leavesError && employeeLeaveHistory.length === 0 && (
              <div className="font-poppins text-[12px] text-muted-foreground">No leave history found.</div>
            )}
            {employeeLeaveHistory.map((entry) => {
              const st = STATUS_STYLES[entry.status] ?? STATUS_STYLES.PENDING;
              return (
                <div key={entry.id} className="bg-card rounded-xl border border-border p-4 flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-poppins text-[12px] font-semibold text-foreground">{entry.leaveType}</p>
                    <span
                      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-semibold w-fit"
                      style={{ backgroundColor: st.bg, color: st.text }}
                    >
                      {entry.status.charAt(0) + entry.status.slice(1).toLowerCase()}
                    </span>
                  </div>
                  <p className="font-poppins text-[11px] text-muted-foreground">
                    {formatDateRange(entry.startDate, entry.resumptionDate)}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}