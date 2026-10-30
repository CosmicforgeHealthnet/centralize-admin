"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { ArrowLeft, CreditCard, Phone, Mail, Calendar, Briefcase, MapPin, Users, FileText } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";
import LeaveHistory from "./LeaveHistory";
import LeaveMonitor from "./LeaveMonitor";

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  APPROVED: { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
  PENDING: { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  DENIED: { bg: "rgba(246,69,69,0.12)", text: "#F64545" },
};

type SubView = "detail" | "history" | "monitor";

function LeftPanel({ emp }: { emp: { name: string | null; avatarUrl: string | null; employeeCode: string | null; phone: string | null; email: string | null; employmentDate: string | null; position: string | null; location: string | null; headOfDepartment: string | null } }) {
  return (
    <div className="flex flex-col gap-3 w-full md:w-[175px] md:shrink-0">
      <div className="w-full md:w-[175px] h-[180px] rounded-xl overflow-hidden bg-muted flex items-center justify-center">
        {emp.avatarUrl ? (
          <Image src={emp.avatarUrl} alt={emp.name || "Employee"} width={175} height={180} className="object-cover w-full h-full" />
        ) : (
          <div className="w-full h-full bg-primary/10 flex items-center justify-center">
            <span className="text-[40px] font-poppins font-bold text-primary">{emp.name?.charAt(0) || "?"}</span>
          </div>
        )}
      </div>
      <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2.5">
        {[
          { icon: <CreditCard className="w-3.5 h-3.5" />, label: "Employee ID:", value: emp.employeeCode || "—" },
          { icon: <Phone className="w-3.5 h-3.5" />, label: "Phone Number:", value: emp.phone || "—" },
          { icon: <Mail className="w-3.5 h-3.5" />, label: "Email Address:", value: emp.email || "—" },
          { icon: <Calendar className="w-3.5 h-3.5" />, label: "Employment Date:", value: emp.employmentDate || "—" },
          { icon: <Briefcase className="w-3.5 h-3.5" />, label: "Position:", value: emp.position || "—" },
          { icon: <MapPin className="w-3.5 h-3.5" />, label: "Location:", value: emp.location || "—" },
          { icon: <Users className="w-3.5 h-3.5" />, label: "Head of Department:", value: emp.headOfDepartment || "—" },
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
    </div>
  );
}

export default function LeaveRequestDetail({ leaveId, onBack }: { leaveId: string; onBack: () => void }) {
  const [subView, setSubView] = useState<SubView>("detail");

  const selectedLeave = useHrmStore((s) => s.selectedLeave);
  const isLoadingLeave = useHrmStore((s) => s.isLoadingLeave);
  const leavesError = useHrmStore((s) => s.leavesError);
  const isUpdatingLeave = useHrmStore((s) => s.isUpdatingLeave);
  const fetchLeave = useHrmStore((s) => s.fetchLeave);
  const clearSelectedLeave = useHrmStore((s) => s.clearSelectedLeave);
  const approveLeave = useHrmStore((s) => s.approveLeave);
  const denyLeave = useHrmStore((s) => s.denyLeave);

  useEffect(() => {
    fetchLeave(leaveId);
    return () => clearSelectedLeave();
  }, [leaveId, fetchLeave, clearSelectedLeave]);

  if (subView === "history" && selectedLeave) {
    return (
      <LeaveHistory
        employeeId={selectedLeave.employee.id || ""}
        onBack={() => setSubView("detail")}
        onViewMonitor={() => setSubView("monitor")}
      />
    );
  }
  if (subView === "monitor" && selectedLeave) {
    return (
      <LeaveMonitor
        employeeId={selectedLeave.employee.id || ""}
        onBack={() => setSubView("history")}
        onViewHistory={() => setSubView("history")}
      />
    );
  }

  if (isLoadingLeave || !selectedLeave) {
    return (
      <div className="flex flex-col gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">Go Back</span>
        </button>
        <div className="font-poppins text-[12px] text-muted-foreground">
          {leavesError ? leavesError : "Loading leave request…"}
        </div>
      </div>
    );
  }

  const req = selectedLeave;
  const st = STATUS_STYLES[req.status] ?? STATUS_STYLES.PENDING;
  const emp = req.employee;

  const handleApprove = async () => {
    await approveLeave(req.id);
  };

  const handleDeny = async () => {
    await denyLeave(req.id);
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
        <LeftPanel emp={emp} />

        {/* Right content */}
        <div className="flex-1 min-w-0 w-full flex flex-col gap-4">
          {/* Leave Request card */}
          <div className="bg-card rounded-xl border border-border p-4">
            {/* Header */}
            <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
              <h2 className="font-poppins text-[14px] font-semibold text-foreground">Leave Request</h2>
              <div className="flex items-center gap-2 flex-wrap">
                {req.status === "PENDING" && (
                  <>
                    <button
                      onClick={handleApprove}
                      disabled={isUpdatingLeave}
                      className="h-[32px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={handleDeny}
                      disabled={isUpdatingLeave}
                      className="h-[32px] px-4 border border-destructive text-destructive text-[12px] font-poppins font-semibold rounded-lg hover:bg-destructive/5 transition-colors disabled:opacity-50"
                    >
                      Deny
                    </button>
                  </>
                )}
                <button
                  onClick={() => setSubView("history")}
                  className="h-[32px] px-4 border border-primary text-primary text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/5 transition-colors"
                >
                  Leave History
                </button>
              </div>
            </div>

            {/* Request details grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-xl border border-border p-3 bg-background flex flex-col gap-0.5">
                <span className="font-poppins text-[10px] text-muted-foreground">Request Status</span>
                <span
                  className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-semibold w-fit mt-1"
                  style={{ backgroundColor: st.bg, color: st.text }}
                >
                  {req.status.charAt(0) + req.status.slice(1).toLowerCase()}
                </span>
              </div>
              <div className="rounded-xl border border-border p-3 bg-background flex flex-col gap-0.5">
                <span className="font-poppins text-[10px] text-muted-foreground">Leave Type</span>
                <span className="font-poppins text-[12px] font-semibold text-foreground">{req.leaveType}</span>
              </div>
              <div className="rounded-xl border border-border p-3 bg-background flex flex-col gap-0.5">
                <span className="font-poppins text-[10px] text-muted-foreground">Start Date</span>
                <span className="font-poppins text-[12px] font-semibold text-foreground">{req.startDate || "—"}</span>
              </div>
              <div className="rounded-xl border border-border p-3 bg-background flex flex-col gap-0.5">
                <span className="font-poppins text-[10px] text-muted-foreground">Resumption Date</span>
                <span className="font-poppins text-[12px] font-semibold text-foreground">{req.resumptionDate || "—"}</span>
              </div>
            </div>
          </div>

          {/* Reason for Leave */}
          <div className="bg-card rounded-xl border border-border p-4">
            <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-3">Reason for Leave</h3>
            <div className="bg-background rounded-xl border border-border p-4">
              <p className="font-poppins text-[12px] text-foreground leading-relaxed whitespace-pre-line">
                {req.reason || "No reason provided."}
              </p>
            </div>
          </div>

          {/* Attachment */}
          {req.attachmentUrl && (
            <div className="bg-card rounded-xl border border-border p-4">
              <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-3">Attachment</h3>
              <a
                href={req.attachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 bg-muted rounded-xl border border-border px-4 py-3 w-fit hover:bg-muted/70 transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4 text-primary" />
                </div>
                <div className="flex flex-col">
                  <span className="font-poppins text-[12px] font-semibold text-foreground">
                    {req.attachmentName || "Attachment"}
                  </span>
                </div>
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}