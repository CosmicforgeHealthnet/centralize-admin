"use client";

// One two-person approval as a card (same card style as the advertising
// Approval Centre), plus the small badges shared by the inbox and the
// product verification pages.

import type { ReactNode } from "react";
import { Clock, ShieldAlert } from "lucide-react";
import { formatAsOf } from "@/components/products/FreshnessBadge";
import { approvalDisplayStatus, type ApprovalItem } from "@/lib/product-approvals";
import { cn } from "@/lib/utils";

const RISK_TONE: Record<string, string> = {
  R0: "bg-muted text-muted-foreground",
  R1: "bg-muted text-foreground",
  R2: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
  R3: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  R4: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
};

export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  if (!risk) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-poppins text-[10px] font-semibold", RISK_TONE[risk] ?? "bg-muted text-foreground")}>
      {(risk === "R3" || risk === "R4") && <ShieldAlert className="h-3 w-3" aria-hidden="true" />}
      Risk {risk}
    </span>
  );
}

const STATUS: Record<string, { label: string; tone: string }> = {
  PROPOSED: { label: "Waiting for decision", tone: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" },
  APPROVED: { label: "Approved", tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" },
  REJECTED: { label: "Rejected", tone: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300" },
  REVOKED: { label: "Revoked", tone: "bg-muted text-muted-foreground" },
  CONSUMED: { label: "Used", tone: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300" },
  EXPIRED: { label: "Expired", tone: "bg-muted text-muted-foreground" },
};

export function ApprovalStatusBadge({ item }: { item: Pick<ApprovalItem, "status" | "expired"> }) {
  const s = approvalDisplayStatus(item);
  const meta = STATUS[s] ?? { label: s, tone: "bg-muted text-foreground" };
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 font-poppins text-[10px] font-semibold", meta.tone)}>{meta.label}</span>;
}

export function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
      <span className="break-all font-poppins text-[12px] font-medium text-foreground">{children}</span>
    </div>
  );
}

export function TimeText({ iso }: { iso: string | null | undefined }) {
  const text = formatAsOf(iso);
  return text ? <time dateTime={iso as string} title={iso as string}>{text}</time> : <span className="text-muted-foreground">—</span>;
}

/** "market: NG · organization: cfmeet" */
export function scopeText(scope: Record<string, string[] | undefined>): string {
  return Object.entries(scope)
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`)
    .join(" · ");
}

export function staffLabel(ref: string | null | undefined, staffId: string | null | undefined): string {
  if (!ref) return "—";
  return staffId && ref === String(staffId) ? "You" : ref;
}

export interface ApprovalCardProps {
  item: ApprovalItem;
  staffId: string | null | undefined;
  onOpen: (item: ApprovalItem) => void;
}

export default function ApprovalCard({ item, staffId, onOpen }: ApprovalCardProps) {
  const s = item.intent_summary;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-label={`Open approval for ${item.capability}${s.target ? ` on ${s.target.id}` : ""}`}
      className="flex w-full flex-col gap-2.5 rounded-[10px] border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="break-all font-mono text-[12px] font-semibold text-foreground">{item.capability}</span>
          <span className="break-all font-poppins text-[11px] text-muted-foreground">
            {s.target ? `${s.target.type} · ${s.target.id}` : "No target"} · requested by {staffLabel(item.requester_ref, staffId)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <RiskBadge risk={item.risk} />
          <ApprovalStatusBadge item={item} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Meta label="Reason">{s.reason_code ?? "—"}</Meta>
        {s.case_reference && <Meta label="Case reference">{s.case_reference}</Meta>}
        {s.expected_version !== null && s.expected_version !== undefined && <Meta label="Expected version">{s.expected_version}</Meta>}
        <Meta label="Scope">{scopeText(s.scope) || "—"}</Meta>
        {item.approver_ref && <Meta label="Decided by">{staffLabel(item.approver_ref, staffId)}</Meta>}
        <span className={cn("ml-auto flex items-center gap-1 font-poppins text-[11px]", item.expired ? "text-red-700 dark:text-red-300" : "text-muted-foreground")}>
          <Clock className="h-3 w-3" aria-hidden="true" />
          {item.expired ? "Expired " : "Expires "}
          <TimeText iso={item.expires_at} />
        </span>
      </div>
    </button>
  );
}
