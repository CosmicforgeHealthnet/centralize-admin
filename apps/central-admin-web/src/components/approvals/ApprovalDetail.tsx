"use client";

// One approval with its actions: Decide (approve or reject, as the second
// person) and Revoke (before it is used). Writes are the Product Admin's
// LOCAL governance commands through POST /operations, with MFA step-up.
// A refusal shows the server's reason; a command is never resent.

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, XCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import OperationStatusDrawer from "@/components/products/OperationStatusDrawer";
import ProductDataState, { ErrorReference, RefreshButton } from "@/components/products/ProductDataState";
import { useProductResource, useSubmitProductOperation } from "@/lib/products.queries";
import {
  buildDecideCommand,
  buildRevokeCommand,
  canDecide,
  canRevoke,
  governanceReadCapability,
  refusalText,
  type ApprovalItem,
} from "@/lib/product-approvals";
import { qualityOf, toProductApiError, type ProductApiError } from "@/lib/products.service";
import type { OperationCommand, ResourceDetailQuery } from "@/types/products.types";
import { ApprovalStatusBadge, Meta, RiskBadge, scopeText, staffLabel, TimeText } from "./ApprovalCard";

/** Reason codes offered for a decision (HQ reason_code pattern ^[A-Z][A-Z0-9_]{2,63}$). */
const DECIDE_REASONS = {
  APPROVE: ["INTENT_VERIFIED", "EVIDENCE_REVIEWED"],
  REJECT: ["INTENT_NOT_JUSTIFIED", "WRONG_TARGET", "SCOPE_TOO_BROAD", "NEEDS_MORE_EVIDENCE"],
} as const;
const REVOKE_REASONS = ["NO_LONGER_NEEDED", "REQUESTED_IN_ERROR", "TARGET_CHANGED", "APPROVER_ACCESS_WITHDRAWN"] as const;

const selectClass = "h-8 rounded-md border border-border bg-background px-2 font-poppins text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const primaryButton = "inline-flex items-center gap-1.5 rounded-md bg-[#1c3866] px-3.5 py-1.5 font-poppins text-[12px] font-medium text-white transition-all hover:bg-[#162d52] disabled:opacity-60";
const outlineButton = "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 font-poppins text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-60";

export interface ApprovalDetailProps {
  productId: string;
  item: ApprovalItem;
  query: ResourceDetailQuery;
  staffId: string | null | undefined;
  onBack: () => void;
}

function Refusal({ error }: { error: ProductApiError }) {
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-md border border-red-600/30 bg-red-50 p-3 dark:bg-red-950/40">
      <p className="font-poppins text-[12px] font-medium text-red-800 dark:text-red-300">Refused: {refusalText(error)}</p>
      <ErrorReference error={error} />
    </div>
  );
}

export default function ApprovalDetail({ productId, item, query, staffId, onBack }: ApprovalDetailProps) {
  const capabilityId = governanceReadCapability(productId);
  const detail = useProductResource<ApprovalItem>(productId, capabilityId, "approvals", item.approval_id, query);
  const approval = detail.data?.result.data ?? item;
  const s = approval.intent_summary;
  const queryClient = useQueryClient();

  const [decision, setDecision] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [decideReason, setDecideReason] = useState<string>(DECIDE_REASONS.APPROVE[0]);
  const [revokeReason, setRevokeReason] = useState<string>(REVOKE_REASONS[0]);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<ProductApiError | null>(null);

  const submit = useSubmitProductOperation(productId, {
    onSuccess: (result) => {
      setOperationId(result.operation.operation_id);
      void queryClient.invalidateQueries({ queryKey: ["products", "product", productId, "resources", capabilityId] });
    },
    onError: (err, command) => {
      // An open outcome is settled by readback (drawer), never by resending.
      if (err.kind === "unknown_outcome") {
        setOperationId(err.operation_id ?? command.command_id);
        setDrawerOpen(true);
      }
    },
  });
  const unknownOutcome = submit.error?.kind === "unknown_outcome";
  const busy = submit.isPending;

  const run = (build: () => OperationCommand, label: string) => {
    setError(null);
    setDone(null);
    let command: OperationCommand;
    try {
      command = build();
    } catch (err) {
      setError(toProductApiError(err));
      return;
    }
    submit.mutate(command, {
      onSuccess: (result) => {
        if (result.operation.status === "UNKNOWN_OUTCOME") setDrawerOpen(true);
        else setDone(label);
      },
      onError: (err) => { if (err.kind !== "unknown_outcome") setError(err); },
    });
  };

  const decidable = canDecide(approval, staffId);
  const revocable = canRevoke(approval, staffId);
  const own = !!staffId && approval.requester_ref === String(staffId);
  const verificationTarget = s.target && approval.capability.startsWith(`${productId}.verification.`) ? s.target.id : null;

  return (
    <section aria-label="Approval details" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 font-poppins text-[12px] font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to list
        </button>
        <RefreshButton onClick={() => void detail.refetch()} busy={detail.isFetching} label="Refresh approval" />
      </div>

      <ProductDataState title="Approval" loading={detail.isPending} error={detail.error} onRetry={() => detail.refetch()} quality={detail.data ? qualityOf(detail.data) : null} compact>
        <div className="flex flex-col gap-4 rounded-[10px] border border-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <h2 className="break-all font-mono text-[13px] font-semibold text-foreground">{approval.capability}</h2>
              <span className="break-all font-poppins text-[11px] text-muted-foreground">Approval {approval.approval_id}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <RiskBadge risk={approval.risk} />
              <ApprovalStatusBadge item={approval} />
            </div>
          </div>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Meta label="Target">{s.target ? `${s.target.type} · ${s.target.id}` : "—"}</Meta>
            <Meta label="Expected version">{s.expected_version ?? "—"}</Meta>
            <Meta label="Reason">{s.reason_code ?? "—"}</Meta>
            <Meta label="Case reference">{s.case_reference ?? "—"}</Meta>
            <Meta label="Scope">{scopeText(s.scope) || "—"}</Meta>
            <Meta label="Requested by">{staffLabel(approval.requester_ref, staffId)}</Meta>
            <Meta label="Decided by">{staffLabel(approval.approver_ref, staffId)}</Meta>
            <Meta label="Requested"><TimeText iso={approval.created_at} /></Meta>
            <Meta label="Decided"><TimeText iso={approval.decided_at} /></Meta>
            <Meta label={approval.expired ? "Expired" : "Expires"}><TimeText iso={approval.expires_at} /></Meta>
            <Meta label="Intent digest"><span className="font-mono text-[11px]">{approval.intent_digest}</span></Meta>
          </dl>
          <p className="font-poppins text-[11px] text-muted-foreground">
            The approval covers exactly this action, target, version, scope and requester. The request body is not stored here; the requester runs the
            identical command once it is approved.
          </p>
        </div>
      </ProductDataState>

      {done && (
        <p role="status" className="flex items-center gap-1.5 rounded-md border border-emerald-600/30 bg-emerald-50 p-3 font-poppins text-[12px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {done}
        </p>
      )}
      {error && <Refusal error={error} />}
      {unknownOutcome && (
        <p role="status" className="rounded-md border border-amber-600/30 bg-amber-50 p-3 font-poppins text-[12px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          The outcome is not known yet. It is settled by reading the operation back; nothing is sent again.
        </p>
      )}
      {operationId && (
        <button type="button" className={outlineButton + " self-start"} onClick={() => setDrawerOpen(true)}>View operation</button>
      )}

      {decidable && !done && (
        <form
          aria-label="Decide"
          className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => buildDecideCommand(productId, approval, decision, decideReason), decision === "APPROVE" ? "Approved. The requester can now run the action once." : "Rejected. The requester has been refused.");
          }}
        >
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Decide as the second person</h3>
          <div role="radiogroup" aria-label="Decision" className="flex flex-wrap gap-2">
            {(["APPROVE", "REJECT"] as const).map((d) => (
              <label key={d} className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 font-poppins text-[12px] ${decision === d ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground"}`}>
                <input
                  type="radio"
                  name="decision"
                  value={d}
                  checked={decision === d}
                  onChange={() => { setDecision(d); setDecideReason(DECIDE_REASONS[d][0]); }}
                  className="sr-only"
                />
                {d === "APPROVE" ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : <XCircle className="h-3.5 w-3.5" aria-hidden="true" />}
                {d === "APPROVE" ? "Approve" : "Reject"}
              </label>
            ))}
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-poppins text-[11px] text-muted-foreground">Reason</span>
            <select className={selectClass} value={decideReason} onChange={(e) => setDecideReason(e.target.value)} aria-label="Decision reason">
              {DECIDE_REASONS[decision].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <p className="font-poppins text-[11px] text-muted-foreground">You may be asked to confirm with your authenticator app.</p>
          <button type="submit" className={primaryButton + " self-start"} disabled={busy || unknownOutcome}>
            {busy ? "Submitting…" : "Submit decision"}
          </button>
        </form>
      )}

      {own && approval.status === "PROPOSED" && !approval.expired && (
        <p className="font-poppins text-[12px] text-muted-foreground">You requested this approval. A different staff member who holds its whole scope must decide it.</p>
      )}
      {own && approval.status === "APPROVED" && !approval.expired && (
        <p className="font-poppins text-[12px] text-muted-foreground">
          Approved by {staffLabel(approval.approver_ref, staffId)}. Run the action once from where you requested it, before the approval expires.
          {verificationTarget && (
            <>
              {" "}
              <Link className="font-semibold text-primary underline" href={`/dashboard/verification?product=${productId}&case=${encodeURIComponent(verificationTarget)}`}>
                Open the case
              </Link>
            </>
          )}
        </p>
      )}

      {revocable && !done && (
        <form
          aria-label="Revoke"
          className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => buildRevokeCommand(productId, approval, revokeReason), "Revoked. The approval can no longer be used.");
          }}
        >
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">{own ? "Withdraw this request" : "Revoke this approval"}</h3>
          <label className="flex flex-col gap-1">
            <span className="font-poppins text-[11px] text-muted-foreground">Reason</span>
            <select className={selectClass} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} aria-label="Revocation reason">
              {REVOKE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <button type="submit" className={outlineButton + " self-start"} disabled={busy || unknownOutcome}>
            {busy ? "Submitting…" : own ? "Withdraw request" : "Revoke approval"}
          </button>
        </form>
      )}

      <OperationStatusDrawer productId={productId} operationId={operationId} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </section>
  );
}
