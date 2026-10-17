"use client";

import { useState } from "react";
import {
  Phone, Mail, MapPin, CalendarClock, Bike, Users,
  ShieldCheck, ShieldX, ShieldAlert, AlertTriangle,
  CheckCircle2, XCircle, Clock, Loader2, ChevronDown,
  ChevronUp, Star, TrendingUp,
} from "lucide-react";
import { useVerificationStore } from "@/stores/verification.store";
import type { DispatchVerificationDetail as TDispatchDetail } from "@/types/verification.types";

const STEP_LABELS: Record<string, string> = {
  identity: "Identity",
  licence: "Licence",
  vehicle: "Vehicle",
  face: "Face Scan",
  guarantor: "Guarantor",
  emergency: "Emergency Contact",
};

const STATUS_STYLES: Record<string, { color: string; bg: string; icon: React.ReactNode }> = {
  approved: {
    color: "#0DA53F",
    bg: "rgba(13,165,63,0.10)",
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
  },
  rejected: {
    color: "#F64545",
    bg: "rgba(246,69,69,0.10)",
    icon: <XCircle className="w-3.5 h-3.5" />,
  },
  pending: {
    color: "#E8B600",
    bg: "rgba(232,182,0,0.10)",
    icon: <Clock className="w-3.5 h-3.5" />,
  },
  pending_review: {
    color: "#E8B600",
    bg: "rgba(232,182,0,0.10)",
    icon: <Clock className="w-3.5 h-3.5" />,
  },
  verified: {
    color: "#0DA53F",
    bg: "rgba(13,165,63,0.10)",
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
  },
  suspended: {
    color: "#F64545",
    bg: "rgba(246,69,69,0.10)",
    icon: <ShieldX className="w-3.5 h-3.5" />,
  },
};

function formatDate(value?: string | null, withTime = false) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  if (!withTime) return date;
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  return `${date}, ${time}`;
}

function SectionCard({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function InfoPair({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
      <span className="font-poppins text-[11px] font-semibold text-foreground break-words">{value ?? "—"}</span>
    </div>
  );
}

function StepBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES["pending"];
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-poppins text-[11px] font-semibold capitalize"
      style={{ color: s.color, backgroundColor: s.bg }}
    >
      {s.icon}
      {status.replace("_", " ")}
    </span>
  );
}

function VerificationSteps({
  steps,
  providerId,
  isActioning,
}: {
  steps: TDispatchDetail["verification_steps"];
  providerId: string;
  isActioning: boolean;
}) {
  const approveStep = useVerificationStore((s) => s.approveStep);
  const rejectStep = useVerificationStore((s) => s.rejectStep);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const handleApprove = async (step: string) => {
    await approveStep(providerId, step, notes[step]);
    setExpanded(null);
  };

  const handleReject = async (step: string) => {
    if (!rejectReason[step]?.trim()) return;
    await rejectStep(providerId, step, rejectReason[step]);
    setExpanded(null);
  };

  const renderStepContent = (step: TDispatchDetail["verification_steps"][0]) => {
    switch (step.step) {
      case 'identity':
        return (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <InfoPair label="Full Name" value={step.provider?.full_name} />
              <InfoPair label="Phone" value={step.provider?.phone} />
              <InfoPair label="Email" value={step.provider?.email} />
              <InfoPair label="Operation Type" value={step.provider?.operation_type} />
            </div>
            {step.verification_documents?.map((doc) => (
              <div key={doc.id} className="border border-border rounded-lg p-3">
                <p className="font-poppins text-[11px] font-semibold mb-2">
                  {doc.document_type.replace(/_/g, ' ').toUpperCase()}
                </p>
                {doc.file_url && (
                  <div className="flex gap-2">
                    <a 
                      href={doc.file_url} 
                      target="_blank" 
                      rel="noreferrer"
                      className="text-[#1c3866] dark:text-[#8b9cf4] text-[11px] hover:underline"
                    >
                      View Document
                    </a>
                    {doc.file_url.match(/\.(jpg|jpeg|png|gif|webp)$/i) && (
                      <img 
                        src={doc.file_url} 
                        alt="Document preview" 
                        className="max-h-32 rounded-lg border border-border"
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        );

      case 'vehicle':
        return (
          <div className="flex flex-col gap-3">
            {step.provider?.bikes?.map((bike) => (
              <div key={bike.id} className="border border-border rounded-lg p-3">
                <div className="grid grid-cols-2 gap-2">
                  <InfoPair label="Brand" value={bike.brand} />
                  <InfoPair label="Model" value={bike.model} />
                  <InfoPair label="Plate Number" value={bike.plate_number} />
                  <InfoPair label="Color" value={bike.color} />
                  <InfoPair label="Year" value={bike.year} />
                  <InfoPair label="Type" value={bike.bike_type} />
                </div>
                {bike.bike_documents?.map((doc) => (
                  <div key={doc.id} className="mt-2 border-t border-border pt-2">
                    <p className="font-poppins text-[10px] text-muted-foreground">
                      {doc.document_type.replace(/_/g, ' ').toUpperCase()}
                    </p>
                    <a 
                      href={doc.file_url} 
                      target="_blank" 
                      rel="noreferrer"
                      className="text-[#1c3866] dark:text-[#8b9cf4] text-[11px] hover:underline"
                    >
                      View Document
                    </a>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );

      case 'face':
        return (
          <div className="flex flex-col gap-3">
            {step.face_checks?.map((face) => (
              <div key={face.id} className="border border-border rounded-lg p-3">
                <div className="grid grid-cols-2 gap-2">
                  <InfoPair label="Match Score" value={face.match_score ? `${face.match_score}%` : 'Pending'} />
                  <InfoPair label="Provider" value={face.provider_used} />
                  <InfoPair label="Result" value={face.result || 'Not checked'} />
                </div>
                {face.selfie_url && (
                  <div className="mt-2">
                    <p className="font-poppins text-[10px] text-muted-foreground mb-1">Selfie</p>
                    <img 
                      src={face.selfie_url} 
                      alt="Selfie" 
                      className="max-h-32 rounded-lg border border-border"
                    />
                  </div>
                )}
                {face.id_doc_url && (
                  <div className="mt-2">
                    <p className="font-poppins text-[10px] text-muted-foreground mb-1">ID Document</p>
                    <img 
                      src={face.id_doc_url} 
                      alt="ID Document" 
                      className="max-h-32 rounded-lg border border-border"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <SectionCard title="Verification Steps" icon={<ShieldCheck className="w-4 h-4" />}>
      <div className="flex flex-col gap-3">
        {steps.map((s) => {
          const label = STEP_LABELS[s.step] ?? s.step;
          const isOpen = expanded === s.step;
          const isPending = s.status === "pending" || s.status === "pending_review";

          return (
            <div key={s.step} className="rounded-lg border border-border overflow-hidden">
              <div
                className="flex items-center justify-between px-3.5 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => setExpanded(isOpen ? null : s.step)}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{ backgroundColor: (STATUS_STYLES[s.status] ?? STATUS_STYLES["pending"]).bg }}
                  >
                    <span style={{ color: (STATUS_STYLES[s.status] ?? STATUS_STYLES["pending"]).color }}>
                      {(STATUS_STYLES[s.status] ?? STATUS_STYLES["pending"]).icon}
                    </span>
                  </div>
                  <span className="font-poppins text-[13px] font-semibold text-foreground">{label}</span>
                </div>
                <div className="flex items-center gap-3">
                  <StepBadge status={s.status} />
                  {isOpen
                    ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                    : <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  }
                </div>
              </div>

              {isOpen && (
                <div className="px-4 pb-4 pt-1 border-t border-border bg-muted/10 flex flex-col gap-3">
                  {/* Show the content being verified */}
                  {renderStepContent(s)}

                  {s.rejection_reason && (
                    <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/8 border border-red-500/20">
                      <AlertTriangle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                      <p className="font-poppins text-[11px] text-red-500">{s.rejection_reason}</p>
                    </div>
                  )}

                  {s.reviewed_at && (
                    <p className="font-poppins text-[10px] text-muted-foreground">
                      Reviewed: {formatDate(s.reviewed_at, true)}
                    </p>
                  )}

                  {isPending && (
                    <div className="flex flex-col gap-2.5 mt-1">
                      <div>
                        <label className="font-poppins text-[10px] text-muted-foreground font-medium">
                          Notes (optional)
                        </label>
                        <textarea
                          value={notes[s.step] ?? ""}
                          onChange={(e) => setNotes((p) => ({ ...p, [s.step]: e.target.value }))}
                          rows={2}
                          placeholder="Add a note..."
                          className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-[11px] font-poppins bg-background text-foreground outline-none focus:border-[#1c3866] dark:focus:border-[#8b9cf4] resize-none placeholder:text-muted-foreground"
                        />
                      </div>
                      <div>
                        <label className="font-poppins text-[10px] text-muted-foreground font-medium">
                          Rejection reason
                        </label>
                        <textarea
                          value={rejectReason[s.step] ?? ""}
                          onChange={(e) => setRejectReason((p) => ({ ...p, [s.step]: e.target.value }))}
                          rows={2}
                          placeholder="Required to reject..."
                          className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-[11px] font-poppins bg-background text-foreground outline-none focus:border-[#1c3866] dark:focus:border-[#8b9cf4] resize-none placeholder:text-muted-foreground"
                        />
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button
                          disabled={isActioning || !rejectReason[s.step]?.trim()}
                          onClick={() => handleReject(s.step)}
                          className="h-[32px] px-4 rounded-lg bg-[#F64545] text-white text-[11px] font-poppins font-semibold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                        >
                          {isActioning && <Loader2 className="w-3 h-3 animate-spin" />}
                          Reject
                        </button>
                        <button
                          disabled={isActioning}
                          onClick={() => handleApprove(s.step)}
                          className="h-[32px] px-4 rounded-lg bg-[#0DA53F] text-white text-[11px] font-poppins font-semibold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                        >
                          {isActioning && <Loader2 className="w-3 h-3 animate-spin" />}
                          Approve
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

function BikeCard({ bike }: { bike: TDispatchDetail["bikes"][0] }) {
  const [open, setOpen] = useState(false);
  const s = STATUS_STYLES[bike.verification_status] ?? STATUS_STYLES["pending"];

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div
        className="flex items-center justify-between px-3.5 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Bike className="w-4 h-4 text-muted-foreground" />
          </div>
          <div>
            <p className="font-poppins text-[12px] font-semibold text-foreground">
              {bike.brand} {bike.model}
            </p>
            <p className="font-poppins text-[10px] text-muted-foreground">{bike.plate_number}</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <span
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-poppins text-[11px] font-semibold capitalize"
            style={{ color: s.color, backgroundColor: s.bg }}
          >
            {s.icon}
            {bike.verification_status.replace("_", " ")}
          </span>
          {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-border bg-muted/10">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 mb-3">
            <InfoPair label="Type"    value={bike.bike_type} />
            <InfoPair label="Color"   value={bike.color}     />
            <InfoPair label="Year"    value={bike.year}      />
            <InfoPair label="Primary" value={bike.is_primary ? "Yes" : "No"} />
            <InfoPair label="Active"  value={bike.is_active  ? "Yes" : "No"} />
          </div>

          {bike.bike_documents.length > 0 && (
            <div>
              <p className="font-poppins text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Documents
              </p>
              <div className="flex flex-col gap-1.5">
                {bike.bike_documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/40 border border-border"
                  >
                    <span className="font-poppins text-[11px] text-foreground capitalize">
                      {doc.document_type.replace(/_/g, " ")}
                    </span>
                    <div className="flex items-center gap-2">
                      <StepBadge status={doc.status} />
                      {doc.file_url && (
                        <a
                          href={doc.file_url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-poppins text-[11px] text-[#1c3866] dark:text-[#8b9cf4] hover:underline"
                        >
                          View
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AuditLog({ logs }: { logs: TDispatchDetail["verificationAudit"] }) {
  const ACTION_COLOR: Record<string, string> = {
    approved:      "#0DA53F",
    fully_approved: "#0DA53F",
    rejected:      "#F64545",
    suspended:     "#F64545",
    unsuspended:   "#E8B600",
  };

  return (
    <SectionCard title="Audit Log" icon={<ShieldAlert className="w-4 h-4" />}>
      {logs.length === 0 ? (
        <p className="text-center py-6 font-poppins text-[12px] text-muted-foreground">
          No audit entries yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {logs.map((log) => {
            const color = ACTION_COLOR[log.action] ?? "#E8B600";
            return (
              <div key={log.id} className="flex gap-3 items-start">
                <div
                  className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                  style={{ backgroundColor: color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span
                      className="font-poppins text-[11px] font-semibold capitalize"
                      style={{ color }}
                    >
                      {log.action.replace(/_/g, " ")}
                    </span>
                    <span className="font-poppins text-[10px] text-muted-foreground">
                      — {STEP_LABELS[log.step] ?? log.step}
                    </span>
                    {log.performedByAdmin && (
                      <span className="font-poppins text-[10px] text-muted-foreground">
                        by {log.performedByAdmin.name}
                      </span>
                    )}
                  </div>
                  {log.notes && (
                    <p className="font-poppins text-[11px] text-foreground mt-0.5">{log.notes}</p>
                  )}
                  <p className="font-poppins text-[10px] text-muted-foreground mt-0.5">
                    {formatDate(log.created_at, true)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function SuspendModal({
  onClose,
  onConfirm,
  isLoading,
}: {
  onClose: () => void;
  onConfirm: (reason: string) => void;
  isLoading: boolean;
}) {
  const [reason, setReason] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-card rounded-2xl p-6 w-full max-w-md shadow-xl border border-border">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center">
            <ShieldX className="w-4 h-4 text-red-500" />
          </div>
          <h2 className="font-poppins text-[15px] font-semibold text-foreground">Suspend Provider</h2>
        </div>
        <p className="font-poppins text-[12px] text-muted-foreground mb-4">
          This will deactivate the provider and all their bikes. You can unsuspend at any time.
        </p>
        <div>
          <label className="font-poppins text-[11px] text-muted-foreground font-medium">
            Reason <span className="text-red-500">*</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Enter suspension reason..."
            className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-[12px] font-poppins text-foreground bg-background outline-none focus:border-red-500 resize-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="h-[36px] px-5 rounded-lg border border-border text-[12px] font-poppins text-muted-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={!reason.trim() || isLoading}
            onClick={() => onConfirm(reason)}
            className="h-[36px] px-5 rounded-lg bg-[#F64545] text-white text-[12px] font-poppins font-semibold hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Suspend
          </button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  detail: TDispatchDetail;
}

export default function DispatchVerificationDetail({ detail }: Props) {
  const isActioning = useVerificationStore((s) => s.isActioning);
  const suspend     = useVerificationStore((s) => s.suspend);
  const unsuspend   = useVerificationStore((s) => s.unsuspend);

  const [showSuspend, setShowSuspend] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const isSuspended = detail.rawStatus === "suspended";

  const showToast = (type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSuspend = async (reason: string) => {
    try {
      await suspend(detail.id, reason);
      setShowSuspend(false);
      showToast("success", "Provider suspended.");
    } catch {
      showToast("error", "Failed to suspend provider.");
    }
  };

  const handleUnsuspend = async () => {
    try {
      await unsuspend(detail.id);
      showToast("success", "Provider unsuspended.");
    } catch {
      showToast("error", "Failed to unsuspend provider.");
    }
  };

  const getInitials = (name: string) =>
    name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);

  const overallStyle = STATUS_STYLES[detail.rawStatus] ?? STATUS_STYLES["pending"];

  return (
    <div className="flex flex-col gap-4">
      {toast && (
        <div
          className={`fixed top-5 right-5 z-[100] px-4 py-3 rounded-[10px] shadow-lg text-[13px] font-poppins text-white transition-all ${
            toast.type === "success" ? "bg-green-500" : "bg-red-500"
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* ── Provider Header Card ── */}
      <div className="rounded-xl border border-border bg-card p-4 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0 bg-muted flex items-center justify-center">
          <div className="w-full h-full bg-primary/10 flex items-center justify-center">
            <span className="text-[22px] font-poppins font-bold text-primary">
              {getInitials(detail.full_name ?? "?")}
            </span>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h2 className="font-poppins text-[15px] font-semibold text-foreground">
              {detail.full_name}
            </h2>
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-poppins text-[11px] font-semibold capitalize"
              style={{ color: overallStyle.color, backgroundColor: overallStyle.bg }}
            >
              {overallStyle.icon}
              {detail.rawStatus.replace("_", " ")}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {detail.phone && (
              <span className="flex items-center gap-1.5 font-poppins text-[11px] text-muted-foreground">
                <Phone className="w-3 h-3" /> {detail.phone}
              </span>
            )}
            {detail.email && (
              <span className="flex items-center gap-1.5 font-poppins text-[11px] text-muted-foreground">
                <Mail className="w-3 h-3" /> {detail.email}
              </span>
            )}
            {(detail.city || detail.state) && (
              <span className="flex items-center gap-1.5 font-poppins text-[11px] text-muted-foreground">
                <MapPin className="w-3 h-3" /> {[detail.city, detail.state].filter(Boolean).join(", ")}
              </span>
            )}
            <span className="flex items-center gap-1.5 font-poppins text-[11px] text-muted-foreground">
              <CalendarClock className="w-3 h-3" /> Joined {formatDate(detail.created_at)}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap sm:flex-col gap-2 shrink-0">
          <div className="flex items-center gap-1.5 bg-muted/60 rounded-lg px-3 py-2">
            <Star className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-poppins text-[12px] font-semibold text-foreground">
              {detail.avg_rating != null ? Number(detail.avg_rating).toFixed(1) : "—"}
            </span>
            <span className="font-poppins text-[10px] text-muted-foreground">rating</span>
          </div>
          <div className="flex items-center gap-1.5 bg-muted/60 rounded-lg px-3 py-2">
            <TrendingUp className="w-3.5 h-3.5 text-[#1c3866] dark:text-[#8b9cf4]" />
            <span className="font-poppins text-[12px] font-semibold text-foreground">
              {detail.total_trips ?? 0}
            </span>
            <span className="font-poppins text-[10px] text-muted-foreground">trips</span>
          </div>
        </div>
      </div>

      {/* ── Main Grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left col — steps + bikes */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <VerificationSteps
            steps={detail.verification_steps}
            providerId={detail.id}
            isActioning={isActioning}
          />

          {detail.bikes.length > 0 && (
            <SectionCard title={`Bikes (${detail.bikes.length})`} icon={<Bike className="w-4 h-4" />}>
              <div className="flex flex-col gap-3">
                {detail.bikes.map((bike) => (
                  <BikeCard key={bike.id} bike={bike} />
                ))}
              </div>
            </SectionCard>
          )}

          <AuditLog logs={detail.verificationAudit} />
        </div>

        {/* Right col — contacts + suspend */}
        <div className="flex flex-col gap-4">
        {(detail.guarantors ?? []).length > 0 && (
            <SectionCard title="Guarantors" icon={<Users className="w-4 h-4" />}>
              <div className="flex flex-col gap-3">
                {detail.guarantors.map((g) => (
                  <div key={g.id} className="rounded-lg bg-muted/40 border border-border p-3">
                    <p className="font-poppins text-[12px] font-semibold text-foreground mb-1.5">
                      {g.full_name}
                    </p>
                    <div className="flex flex-col gap-1">
                      <span className="flex items-center gap-1.5 font-poppins text-[11px] text-muted-foreground">
                        <Phone className="w-3 h-3" /> {g.phone}
                      </span>
                      {g.email && (
                        <span className="flex items-center gap-1.5 font-poppins text-[11px] text-muted-foreground">
                          <Mail className="w-3 h-3" /> {g.email}
                        </span>
                      )}
                      <span className="font-poppins text-[10px] text-muted-foreground capitalize mt-0.5">
                        {g.relationship}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

{(detail.emergency_contacts ?? []).length > 0 && (
            <SectionCard title="Emergency Contacts" icon={<Phone className="w-4 h-4" />}>
              <div className="flex flex-col gap-3">
                {detail.emergency_contacts.map((ec) => (
                  <div key={ec.id} className="rounded-lg bg-muted/40 border border-border p-3">
                    <p className="font-poppins text-[12px] font-semibold text-foreground mb-1.5">
                      {ec.full_name}
                    </p>
                    <div className="flex flex-col gap-1">
                      <span className="flex items-center gap-1.5 font-poppins text-[11px] text-muted-foreground">
                        <Phone className="w-3 h-3" /> {ec.phone}
                      </span>
                      <span className="font-poppins text-[10px] text-muted-foreground capitalize mt-0.5">
                        {ec.relationship}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Suspend / Unsuspend */}
          <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <ShieldX className="w-4 h-4 text-muted-foreground" />
              <h3 className="font-poppins text-[12px] font-semibold text-foreground">Account Control</h3>
            </div>
            <p className="font-poppins text-[11px] text-muted-foreground">
              {isSuspended
                ? "This provider is currently suspended. Unsuspending will restore access and re-activate all bikes."
                : "Suspending will deactivate this provider and all associated bikes immediately."}
            </p>
            {isSuspended ? (
              <button
                disabled={isActioning}
                onClick={handleUnsuspend}
                className="h-[36px] w-full rounded-lg bg-[#0DA53F] text-white font-poppins text-[12px] font-semibold hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isActioning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <ShieldCheck className="w-3.5 h-3.5" />
                Unsuspend Provider
              </button>
            ) : (
              <button
                disabled={isActioning}
                onClick={() => setShowSuspend(true)}
                className="h-[36px] w-full rounded-lg bg-[#F64545] text-white font-poppins text-[12px] font-semibold hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <ShieldX className="w-3.5 h-3.5" />
                Suspend Provider
              </button>
            )}
          </div>
        </div>
      </div>

      {showSuspend && (
        <SuspendModal
          isLoading={isActioning}
          onClose={() => setShowSuspend(false)}
          onConfirm={handleSuspend}
        />
      )}
    </div>
  );
}