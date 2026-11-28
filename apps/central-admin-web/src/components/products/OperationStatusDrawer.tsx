"use client";

// Status and audit of one product operation (GET /{p}/operations/{id} and
// /{p}/operations/{id}/audit). Every read lets the Product Admin settle an
// UNKNOWN_OUTCOME by authoritative readback. There is deliberately no
// "resend" action: commands are never resent.

import { X } from "lucide-react";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { useOperation, useOperationAudit, UNSETTLED_OPERATION_STATUSES } from "@/lib/products.queries";
import { cn } from "@/lib/utils";
import type { OperationAuditRecord, OperationReadback, OperationView } from "@/types/products.types";
import { formatAsOf } from "./FreshnessBadge";
import ProductDataState, { RefreshButton } from "./ProductDataState";

const STATUS: Record<string, { label: string; tone: string; explain: string }> = {
  RECORDED: { label: "Recorded", tone: "border-border bg-muted text-foreground", explain: "The command is recorded and waiting to be sent to the source." },
  DISPATCHING: { label: "Sending to source", tone: "border-sky-600/30 bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300", explain: "The command is being sent to the source system." },
  SUCCEEDED: { label: "Succeeded", tone: "border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300", explain: "The source confirmed the change." },
  FAILED: { label: "Failed", tone: "border-red-600/30 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300", explain: "The source refused the command or it could not be completed. Nothing was changed by this operation unless the evidence says otherwise." },
  REJECTED: { label: "Rejected", tone: "border-red-600/30 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300", explain: "The Product Admin refused the command before anything ran." },
  UNKNOWN_OUTCOME: {
    label: "Outcome unknown",
    tone: "border-amber-600/30 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    explain: "The source did not confirm the result. This operation is settled by readback, never resent: each refresh asks the product to read the original operation back from the source.",
  },
};

const READBACK: Record<string, string> = {
  SETTLED_BY_READBACK: "Settled by readback: the source's record of the original operation decided the outcome.",
  STILL_UNKNOWN: "Read back, still unknown: the source has not reported a final result yet.",
  NO_READBACK_CONTRACT: "The source offers no readback for this action. An operator must confirm the outcome with the source owner.",
  READBACK_REQUIRES_STAFF_CONTEXT: "Readback needs a valid staff context (for example a recent MFA confirmation) before the source can be asked.",
  READBACK_UNAVAILABLE: "Readback is unavailable right now. Try again later; the command will not be resent.",
};

/** Human label of an operation status. */
export function operationStatusLabel(status: string): string {
  return STATUS[status]?.label ?? status;
}

/** Explanation of an operation status (UNKNOWN_OUTCOME: "settled by readback, never resent"). */
export function operationStatusExplanation(status: string): string {
  return STATUS[status]?.explain ?? "The Product Admin reported a status this page does not know.";
}

/** Explanation of a readback state. */
export function readbackExplanation(readback: OperationReadback): string {
  return READBACK[readback.state] ?? `Readback state: ${readback.state}`;
}

export function OperationStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold", STATUS[status]?.tone ?? "border-border bg-muted text-foreground", className)}>
      {operationStatusLabel(status)}
    </span>
  );
}

const yesNo = (value: boolean) => (value ? "Yes" : "No");

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="break-words text-[13px] text-foreground">{children}</dd>
    </div>
  );
}

function Time({ iso }: { iso: string | null | undefined }) {
  const text = formatAsOf(iso);
  return text ? <time dateTime={iso as string} title={iso as string}>{text}</time> : <span className="text-muted-foreground">—</span>;
}

/** The operation summary (status, outcome_known, executed, readback). Usable outside the drawer. */
export function OperationSummary({ operation, checkedAt }: { operation: OperationView; checkedAt?: number }) {
  const unsettled = UNSETTLED_OPERATION_STATUSES.includes(operation.status);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <OperationStatusBadge status={operation.status} />
        {operation.replay && <span className="text-[11px] text-muted-foreground">(same command seen before; no second execution)</span>}
      </div>
      <p className={cn("text-[12px] leading-relaxed", operation.status === "UNKNOWN_OUTCOME" ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground")}>
        {operationStatusExplanation(operation.status)}
      </p>
      {operation.readback && (
        <p role="status" className="rounded-md border border-border bg-muted/50 p-2 text-[12px] text-foreground">
          {readbackExplanation(operation.readback)}
          {operation.readback.reason && <span className="ml-1 font-mono text-[10px] text-muted-foreground">({operation.readback.reason})</span>}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3">
        <Field label="Outcome known">{yesNo(operation.outcome_known)}</Field>
        <Field label="Executed at source">{operation.outcome_known ? yesNo(operation.executed) : "Not known yet"}</Field>
        <Field label="Reason">{operation.reason_code ? <span className="font-mono text-[12px]">{operation.reason_code}</span> : "—"}</Field>
        <Field label="Source status">{operation.source_status ?? "—"}</Field>
        <Field label="Source version">{operation.source_version ?? "—"}</Field>
        <Field label="Readback">{operation.readback ? operation.readback.state : unsettled ? "Not attempted yet" : "Not needed"}</Field>
        <Field label="Created"><Time iso={operation.created_at} /></Field>
        <Field label="Updated"><Time iso={operation.updated_at} /></Field>
        <Field label="Capability"><span className="font-mono text-[12px]">{operation.capability_id}</span></Field>
        <Field label="Approval">{operation.approval_ref ? <span className="font-mono text-[12px]">{operation.approval_ref}</span> : "—"}</Field>
      </dl>
      {checkedAt ? (
        <p className="text-[11px] text-muted-foreground">
          Checked <Time iso={new Date(checkedAt).toISOString()} />
        </p>
      ) : null}
    </div>
  );
}

/** The operation's audit trail as a compact list. */
export function OperationAuditList({ records }: { records: OperationAuditRecord[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {records.map((r, i) => (
        <li key={`${r.occurred_at}-${i}`} className="rounded-md border border-border p-2 text-[12px]">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-foreground">{r.outcome}</span>
            <span className="text-[11px] text-muted-foreground"><Time iso={r.occurred_at} /></span>
          </div>
          <p className="text-muted-foreground">
            {r.action} · {r.method} {r.endpoint}
            {r.reason_code && <> · <span className="font-mono">{r.reason_code}</span></>}
          </p>
          {r.correlation_id && <p className="break-all font-mono text-[10px] text-muted-foreground">Ref: {r.correlation_id}</p>}
        </li>
      ))}
    </ol>
  );
}

export interface OperationStatusDrawerProps {
  productId: string;
  /** The operation to show (for a fresh submit: the command's command_id). */
  operationId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Heading, default "Operation status". */
  title?: string;
  /** While open and unsettled, read back automatically every N ms (default 30000; 0 turns it off). */
  pollUnsettledMs?: number;
}

/** Right-side drawer with the operation's status and its audit trail. */
export default function OperationStatusDrawer({ productId, operationId, open, onOpenChange, title = "Operation status", pollUnsettledMs = 30000 }: OperationStatusDrawerProps) {
  const operation = useOperation(productId, operationId, { enabled: open, pollUnsettledMs: pollUnsettledMs || undefined, stepUp: true });
  const audit = useOperationAudit(productId, operationId, { enabled: open, stepUp: true });
  const view = operation.data?.result;
  const unsettled = !!view && UNSETTLED_OPERATION_STATUSES.includes(view.status);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="data-[vaul-drawer-direction=right]:sm:max-w-md">
        <DrawerHeader className="flex flex-row items-start justify-between gap-2 border-b border-border">
          <div className="min-w-0">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription className="break-all font-mono text-[11px]">{operationId ?? "No operation selected"}</DrawerDescription>
          </div>
          <div className="flex items-center gap-1">
            <RefreshButton
              onClick={() => { void operation.refetch(); void audit.refetch(); }}
              busy={operation.isFetching || audit.isFetching}
              label={unsettled ? "Read back now" : "Refresh"}
            />
            <DrawerClose className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Close">
              <X className="h-4 w-4" aria-hidden="true" />
            </DrawerClose>
          </div>
        </DrawerHeader>
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
          <section aria-label="Status">
            <ProductDataState title="Operation" loading={operation.isPending && !!operationId} error={operation.error} onRetry={() => operation.refetch()} empty={!operationId} emptyMessage="Select an operation to see its status." embedded compact>
              {view && <OperationSummary operation={view} checkedAt={operation.dataUpdatedAt} />}
            </ProductDataState>
          </section>
          <section aria-label="Audit trail" className="flex flex-col gap-2">
            <h3 className="text-[13px] font-semibold text-foreground">Audit trail</h3>
            <ProductDataState
              title="Audit records"
              loading={audit.isPending && !!operationId}
              error={audit.error}
              onRetry={() => audit.refetch()}
              empty={!!audit.data && audit.data.result.records.length === 0}
              emptyMessage="No audit records were returned for this operation."
              embedded
              compact
            >
              {audit.data && <OperationAuditList records={audit.data.result.records} />}
            </ProductDataState>
          </section>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
