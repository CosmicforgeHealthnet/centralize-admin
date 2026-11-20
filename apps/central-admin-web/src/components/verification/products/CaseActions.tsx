"use client";

// Actions on one product verification case.
//
//  - Commands without independent approval (Claim, R2) are sent directly.
//  - Commands that need a second person (R3/R4, TWO_PERSON) go through
//    propose -> a different staff member decides -> the requester runs the
//    SAME command with approval_ref. The prepared command is kept in this
//    browser (lib/prepared-commands) because the approval binds its exact
//    body and operation id.
//  - Every write may ask for an MFA step-up. Nothing is ever resent
//    automatically: an open outcome is settled by reading the operation back.
//  - VERSION_CONFLICT is shown as "the case changed - refresh"; a CANCELLED
//    case is withdrawn and offers no actions.

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Send, ShieldCheck } from "lucide-react";
import OperationStatusDrawer, { OperationStatusBadge } from "@/components/products/OperationStatusDrawer";
import ProductDataState, { ErrorReference, RefreshButton } from "@/components/products/ProductDataState";
import { ApprovalStatusBadge, staffLabel, TimeText } from "@/components/approvals/ApprovalCard";
import { capabilityUsable } from "@/components/approvals/CapabilityNotice";
import { usePreparedCommands, type PreparedCommand } from "@/lib/prepared-commands";
import {
  approvalIdOf,
  buildBridgeCommand,
  buildProposeCommand,
  buildRevokeCommand,
  governanceReadCapability,
  intentDigestOf,
  isVersionConflictReason,
  proposeCapability,
  refusalText,
  type ApprovalItem,
} from "@/lib/product-approvals";
import { useOperation, useProductResource, useSubmitProductOperation } from "@/lib/products.queries";
import { ProductApiError, toProductApiError } from "@/lib/products.service";
import type { CommandScope, OperationView, ProductCapabilities, ProductCapability, ResourceDetailQuery } from "@/types/products.types";
import { actionsFor, caseTargetType, commandCapability, type CaseAction, type VerificationCaseDetail } from "./verification-cases";

const primaryButton = "inline-flex items-center gap-1.5 rounded-md bg-[#1c3866] px-3.5 py-1.5 font-poppins text-[12px] font-medium text-white transition-all hover:bg-[#162d52] disabled:opacity-60";
const outlineButton = "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 font-poppins text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-60";
const selectClass = "h-8 rounded-md border border-border bg-background px-2 font-poppins text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// ── Outcome display ───────────────────────────────────────────────

function VersionConflict({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-600/30 bg-amber-50 p-3 dark:bg-amber-950/40">
      <p className="flex items-center gap-1.5 font-poppins text-[12px] font-medium text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" /> The case changed since you loaded it — refresh before acting again.
      </p>
      <button type="button" className={outlineButton} onClick={onRefresh}>Refresh case</button>
    </div>
  );
}

function Refusal({ error, onRefresh }: { error: ProductApiError; onRefresh: () => void }) {
  if (isVersionConflictReason(error.reason)) return <VersionConflict onRefresh={onRefresh} />;
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-md border border-red-600/30 bg-red-50 p-3 dark:bg-red-950/40">
      <p className="font-poppins text-[12px] font-medium text-red-800 dark:text-red-300">Refused: {refusalText(error)}</p>
      <ErrorReference error={error} />
    </div>
  );
}

/** Settled (or open) outcome of a sent case command. */
export function OperationOutcome({ operation, onRefresh, onView }: { operation: OperationView; onRefresh: () => void; onView: () => void }) {
  if (operation.status === "FAILED" && isVersionConflictReason(operation.reason_code)) return <VersionConflict onRefresh={onRefresh} />;
  const text =
    operation.status === "SUCCEEDED" ? "Done: the source confirmed the change."
      : operation.status === "FAILED" ? `The source refused the command (${operation.reason_code ?? "no reason given"}).`
        : operation.status === "REJECTED" ? `Refused before anything ran (${operation.reason_code ?? "no reason given"}).`
          : "Sent; the outcome is not known yet. It is settled by reading the operation back, never by sending again.";
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <OperationStatusBadge status={operation.status} className="self-start" />
        <p className="font-poppins text-[12px] text-foreground">{text}</p>
      </div>
      <button type="button" className={outlineButton} onClick={onView}>View operation</button>
    </div>
  );
}

// ── Action form ───────────────────────────────────────────────────

interface ActionValues {
  reason: string;
  note: string;
  approved: string[];
}

function ActionForm({
  action,
  item,
  needsApproval,
  busy,
  onSubmit,
  onCancel,
}: {
  action: CaseAction;
  item: VerificationCaseDetail;
  needsApproval: boolean;
  busy: boolean;
  onSubmit: (values: ActionValues) => void;
  onCancel: () => void;
}) {
  const requested = "requested_capabilities" in item.details ? item.details.requested_capabilities : [];
  const [reason, setReason] = useState(action.reasons[0]);
  const [note, setNote] = useState("");
  const [approved, setApproved] = useState<string[]>(requested);
  const capsInvalid = !!action.approvedCapabilities && requested.length > 0 && (approved.length < 1 || approved.length > 16);

  return (
    <form
      aria-label={action.label}
      className="flex flex-col gap-3 rounded-[10px] border border-border bg-background p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!capsInvalid) onSubmit({ reason, note: note.trim(), approved });
      }}
    >
      <h4 className="font-poppins text-[13px] font-semibold text-foreground">{action.label}</h4>
      <label className="flex flex-col gap-1">
        <span className="font-poppins text-[11px] text-muted-foreground">Reason{action.reasonRequired ? " (required)" : ""}</span>
        <select className={selectClass} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
          {action.reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      {action.approvedCapabilities && requested.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="font-poppins text-[11px] text-muted-foreground">Capabilities to approve (at least one)</legend>
          <div className="flex flex-wrap gap-2">
            {requested.map((c) => (
              <label key={c} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-foreground">
                <input
                  type="checkbox"
                  checked={approved.includes(c)}
                  onChange={(e) => setApproved((list) => (e.target.checked ? [...list, c] : list.filter((x) => x !== c)))}
                />
                {c}
              </label>
            ))}
          </div>
          {capsInvalid && <p className="font-poppins text-[11px] text-red-700 dark:text-red-300">Select at least one capability.</p>}
        </fieldset>
      )}
      <label className="flex flex-col gap-1">
        <span className="font-poppins text-[11px] text-muted-foreground">Note (optional, no personal data)</span>
        <textarea
          className="min-h-[60px] rounded-md border border-border bg-background p-2 font-poppins text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Note"
        />
      </label>
      <p className="font-poppins text-[11px] text-muted-foreground">
        {needsApproval
          ? "A different staff member must approve this exact request (case version " + item.version + "). Then you run it once from here."
          : "This is sent once for case version " + item.version + ". You may be asked to confirm with your authenticator app."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButton} disabled={busy || capsInvalid}>
          {needsApproval ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
          {busy ? "Submitting…" : needsApproval ? "Request approval" : action.label}
        </button>
        <button type="button" className={outlineButton} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

// ── A request waiting for (or past) its approval ──────────────────

function PreparedRequest({
  productId,
  record,
  item,
  readQuery,
  staffId,
  onUpdate,
  onRemove,
  onRefresh,
}: {
  productId: string;
  record: PreparedCommand;
  item: VerificationCaseDetail;
  readQuery: ResourceDetailQuery;
  staffId: string;
  onUpdate: (patch: Partial<PreparedCommand>) => void;
  onRemove: () => void;
  onRefresh: () => void;
}) {
  const commandId = record.command.command_id;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerOperation, setDrawerOperation] = useState<string>(commandId);
  const [error, setError] = useState<ProductApiError | null>(null);

  // A propose whose answer was lost: its operation evidence names the approval.
  const proposeOp = useOperation(productId, record.approval_id ? null : record.propose_command_id);
  const resolvedId = approvalIdOf(proposeOp.data?.result);
  useEffect(() => {
    if (!record.approval_id && resolvedId) onUpdate({ approval_id: resolvedId });
  }, [record.approval_id, resolvedId, onUpdate]);

  const approval = useProductResource<ApprovalItem>(productId, governanceReadCapability(productId), "approvals", record.approval_id ?? "none", readQuery, {
    enabled: !!record.approval_id,
  });
  const a = approval.data?.result.data ?? null;
  const runOp = useOperation(productId, record.run ? commandId : null);
  const runMutation = useSubmitProductOperation(productId);
  const revokeMutation = useSubmitProductOperation(productId);

  const versionChanged = item.version !== record.command.target.expected_version;
  const runnable = !!a && !record.run && a.status === "APPROVED" && !a.expired && a.requester_ref === staffId && a.intent_digest === record.intent_digest && !versionChanged;
  const dead = !!a && !record.run && (a.status === "REJECTED" || a.status === "REVOKED" || a.expired);

  const run = () => {
    if (!record.approval_id || !runnable) return;
    setError(null);
    const command = { ...record.command, params: { ...record.command.params, approval_ref: record.approval_id } };
    // Marked before sending: Run is never offered again for this command.
    onUpdate({ run: { submitted_at: new Date().toISOString(), approval_ref: record.approval_id } });
    runMutation.mutate(command, {
      onSuccess: () => { setDrawerOperation(commandId); onRefresh(); },
      onError: (err) => {
        // A cancelled step-up sent nothing: the same command may be run again.
        if (err.kind === "mfa_required") onUpdate({ run: null });
        if (err.kind === "unknown_outcome") { setDrawerOperation(commandId); setDrawerOpen(true); } else setError(err);
      },
    });
  };

  const withdraw = () => {
    if (!a) return;
    setError(null);
    let command;
    try { command = buildRevokeCommand(productId, a, "NO_LONGER_NEEDED"); } catch (err) { setError(toProductApiError(err)); return; }
    revokeMutation.mutate(command, {
      onSuccess: () => onRemove(),
      onError: (err) => { if (err.kind === "unknown_outcome") { setDrawerOperation(command.command_id); setDrawerOpen(true); } else setError(err); },
    });
  };

  const operation = runMutation.data?.operation ?? runOp.data?.result ?? null;

  return (
    <li className="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3" aria-label={`Request: ${record.action_label}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="font-poppins text-[13px] font-semibold text-foreground">{record.action_label}</span>
          <span className="break-all font-poppins text-[11px] text-muted-foreground">
            For case version {record.command.target.expected_version} · reason {record.command.reason_code} · requested <TimeText iso={record.created_at} />
          </span>
        </div>
        <div className="flex items-center gap-1">
          {a && <ApprovalStatusBadge item={a} />}
          {record.approval_id && !record.run && (
            <RefreshButton onClick={() => void approval.refetch()} busy={approval.isFetching} label="Check approval status" />
          )}
        </div>
      </div>

      {record.run ? (
        operation ? (
          <OperationOutcome operation={operation} onRefresh={onRefresh} onView={() => { setDrawerOperation(commandId); setDrawerOpen(true); }} />
        ) : runMutation.isPending ? (
          <p role="status" className="font-poppins text-[12px] text-muted-foreground">Sending once…</p>
        ) : !error ? (
          <ProductDataState title="Operation" loading={runOp.isPending} error={runOp.error} onRetry={() => runOp.refetch()} compact embedded />
        ) : null
      ) : !record.approval_id ? (
        <ProductDataState title="Approval request" loading={proposeOp.isPending} error={proposeOp.error} onRetry={() => proposeOp.refetch()} compact embedded>
          <p role="status" className="font-poppins text-[12px] text-muted-foreground">
            The approval request is being recorded{proposeOp.data ? ` (${proposeOp.data.result.status})` : ""}. It is read back, not sent again.
          </p>
        </ProductDataState>
      ) : (
        <ProductDataState title="Approval status" loading={approval.isPending} error={approval.error} onRetry={() => approval.refetch()} compact embedded>
          {a && a.status === "PROPOSED" && !a.expired && (
            <p role="status" className="flex items-center gap-1.5 font-poppins text-[12px] text-foreground">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Waiting for a second staff member to decide. Expires <TimeText iso={a.expires_at} />.
            </p>
          )}
          {a && a.status === "APPROVED" && !a.expired && (
            <p role="status" className="flex items-center gap-1.5 font-poppins text-[12px] text-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> Approved by {staffLabel(a.approver_ref, staffId)}. Run it once before <TimeText iso={a.expires_at} />.
            </p>
          )}
          {a && a.status === "REJECTED" && <p role="status" className="font-poppins text-[12px] text-foreground">Rejected by {staffLabel(a.approver_ref, staffId)}. Nothing was sent.</p>}
          {a && a.status === "REVOKED" && <p role="status" className="font-poppins text-[12px] text-foreground">This approval was revoked. Nothing was sent.</p>}
          {a && a.expired && <p role="status" className="font-poppins text-[12px] text-foreground">This approval expired before it was used. Nothing was sent.</p>}
          {a && a.status === "CONSUMED" && <p role="status" className="font-poppins text-[12px] text-foreground">This approval was already used by an operation.</p>}
          {a && !a.expired && (a.status === "APPROVED" || a.status === "PROPOSED") && versionChanged && <VersionConflict onRefresh={onRefresh} />}
        </ProductDataState>
      )}

      {error && <Refusal error={error} onRefresh={onRefresh} />}

      <div className="flex flex-wrap gap-2">
        {runnable && (
          <button type="button" className={primaryButton} onClick={run} disabled={runMutation.isPending}>
            <Send className="h-3.5 w-3.5" aria-hidden="true" /> Run approved action
          </button>
        )}
        {a && a.status === "PROPOSED" && !a.expired && !record.run && (
          <button type="button" className={outlineButton} onClick={withdraw} disabled={revokeMutation.isPending}>Withdraw request</button>
        )}
        {(record.run || dead || versionChanged || a?.status === "CONSUMED" || (!!approval.error && toProductApiError(approval.error).kind === "not_found")) && (
          <button type="button" className={outlineButton} onClick={onRemove}>Dismiss</button>
        )}
        <Link href={`/dashboard/approvals?tab=mine&product=${productId}`} className="inline-flex items-center px-1 font-poppins text-[12px] font-medium text-primary underline">
          My requests
        </Link>
      </div>

      <OperationStatusDrawer productId={productId} operationId={drawerOperation} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </li>
  );
}

// ── Actions panel ─────────────────────────────────────────────────

export interface CaseActionsProps {
  productId: string;
  item: VerificationCaseDetail;
  capabilities: ProductCapabilities | undefined;
  scope: CommandScope;
  readQuery: ResourceDetailQuery;
  staffId: string | null;
  onRefresh: () => void;
}

function blockedText(capability: ProductCapability): string {
  const codes = capability.blockers.map((b) => b.code).join(", ");
  return `Switched off: ${capability.state}${codes ? ` (${codes})` : ""}`;
}

export default function CaseActions({ productId, item, capabilities, scope, readQuery, staffId, onRefresh }: CaseActionsProps) {
  const prepared = usePreparedCommands(productId, staffId);
  const mine = prepared.records.filter((r) => r.command.target.id === item.case_id);
  const pending = mine.some((r) => !r.run);
  const [openAction, setOpenAction] = useState<string | null>(null);
  const [error, setError] = useState<ProductApiError | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [directId, setDirectId] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const direct = useSubmitProductOperation(productId);
  const propose = useSubmitProductOperation(productId);
  const proposeCap = capabilities?.capabilities.find((c) => c.id === proposeCapability(productId)) ?? null;
  const actions = actionsFor(item);
  const busy = direct.isPending || propose.isPending || preparing;
  const directOperation = direct.data?.operation ?? null;

  if (item.state === "CANCELLED") {
    return (
      <p role="status" className="rounded-md border border-border bg-muted/40 p-3 font-poppins text-[12px] text-foreground">
        Withdrawn by the partner. A withdrawn case stays readable but cannot be acted on.
      </p>
    );
  }

  const sendDirect = (action: CaseAction, values: ActionValues) => {
    setError(null);
    let command;
    try {
      command = buildBridgeCommand({
        capability_id: `${productId}.${action.command}`,
        target: { type: caseTargetType(productId), id: item.case_id, expected_version: item.version },
        body: bodyOf(action, item, values),
        reason_code: values.reason,
        case_reference: item.case_id,
        scope,
      });
    } catch (err) {
      setError(toProductApiError(err));
      return;
    }
    setDirectId(command.command_id);
    direct.mutate(command, {
      onSuccess: (result) => {
        setOpenAction(null);
        if (result.operation.status === "UNKNOWN_OUTCOME") setDrawerOpen(true);
        onRefresh();
      },
      onError: (err) => { if (err.kind === "unknown_outcome") setDrawerOpen(true); else setError(err); },
    });
  };

  const requestApproval = async (action: CaseAction, values: ActionValues) => {
    setError(null);
    if (!staffId) {
      setError(new ProductApiError({ status: null, code: "UNAUTHENTICATED", reason: "SESSION_REQUIRED", source: "client", message: "Sign in again to request an approval." }));
      return;
    }
    setPreparing(true);
    let run;
    let proposeCommand;
    try {
      run = buildBridgeCommand({
        capability_id: `${productId}.${action.command}`,
        target: { type: caseTargetType(productId), id: item.case_id, expected_version: item.version },
        body: bodyOf(action, item, values),
        reason_code: values.reason,
        case_reference: item.case_id,
        scope,
      });
      const digest = await intentDigestOf(run, staffId);
      proposeCommand = buildProposeCommand(productId, run, digest);
      // Kept before sending, so a lost answer is resolved by reading the propose back.
      prepared.save({
        version: 1, product_id: productId, staff_id: staffId, action_label: action.label, command: run, intent_digest: digest,
        propose_command_id: proposeCommand.command_id, approval_id: null, created_at: new Date().toISOString(), expires_at: null, run: null,
      });
    } catch (err) {
      setPreparing(false);
      setError(toProductApiError(err));
      return;
    }
    setPreparing(false);
    const runId = run.command_id;
    propose.mutate(proposeCommand, {
      onSuccess: (result) => {
        const approvalId = approvalIdOf(result.operation);
        const expires = result.operation.approval && typeof result.operation.approval.expires_at === "string" ? result.operation.approval.expires_at : null;
        prepared.update(runId, { approval_id: approvalId, expires_at: expires });
        setOpenAction(null);
      },
      onError: (err) => {
        // Definitely not recorded: forget it. Unknown: keep it and read the propose back.
        if (err.kind !== "unknown_outcome") {
          prepared.remove(runId);
          setError(err);
        } else setOpenAction(null);
      },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {mine.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Your requests for this case">
          {mine.map((record) => (
            <PreparedRequest
              key={record.command.command_id}
              productId={productId}
              record={record}
              item={item}
              readQuery={readQuery}
              staffId={staffId as string}
              onUpdate={(patch) => prepared.update(record.command.command_id, patch)}
              onRemove={() => prepared.remove(record.command.command_id)}
              onRefresh={onRefresh}
            />
          ))}
        </ul>
      )}

      {directOperation && directId && (
        <OperationOutcome operation={directOperation} onRefresh={onRefresh} onView={() => setDrawerOpen(true)} />
      )}
      {error && <Refusal error={error} onRefresh={onRefresh} />}

      {actions.length === 0 ? (
        <p className="font-poppins text-[12px] text-muted-foreground">No actions apply to a case in this state.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Case actions">
            {actions.map((action) => {
              const capability = commandCapability(capabilities, productId, action);
              if (!capability) return null;
              const needsApproval = capability.requires_independent_approval;
              const usable = capabilityUsable(capability) && (!needsApproval || capabilityUsable(proposeCap));
              const reason = !capabilityUsable(capability) ? blockedText(capability) : needsApproval && proposeCap && !capabilityUsable(proposeCap) ? blockedText(proposeCap) : null;
              return (
                <div key={action.id} className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    className={action.destructive ? outlineButton : primaryButton}
                    disabled={!usable || busy || pending}
                    aria-expanded={openAction === action.id}
                    onClick={() => { setError(null); setOpenAction(openAction === action.id ? null : action.id); }}
                  >
                    {action.label}
                    {needsApproval && <span className="rounded bg-white/20 px-1 text-[10px]">2-person</span>}
                  </button>
                  {reason && <span className="font-mono text-[10px] text-muted-foreground">{reason}</span>}
                </div>
              );
            })}
          </div>
          {pending && <p className="font-poppins text-[11px] text-muted-foreground">Finish or dismiss your pending request for this case before starting another.</p>}
          {actions.map((action) => {
            const capability = commandCapability(capabilities, productId, action);
            if (openAction !== action.id || !capability || pending) return null;
            const needsApproval = capability.requires_independent_approval;
            return (
              <ActionForm
                key={action.id}
                action={action}
                item={item}
                needsApproval={needsApproval}
                busy={busy}
                onCancel={() => setOpenAction(null)}
                onSubmit={(values) => (needsApproval ? void requestApproval(action, values) : sendDirect(action, values))}
              />
            );
          })}
        </div>
      )}

      <OperationStatusDrawer productId={productId} operationId={directId} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </div>
  );
}

/** The exact source body (operation_id is added by buildBridgeCommand). Unknown fields are refused by the source. */
function bodyOf(action: CaseAction, item: VerificationCaseDetail, values: ActionValues): Record<string, unknown> {
  const body: Record<string, unknown> = { expected_version: item.version, reason_code: values.reason };
  if (values.note) body.note = values.note;
  if (action.approvedCapabilities && "requested_capabilities" in item.details && item.details.requested_capabilities.length > 0) {
    body.approved_capabilities = values.approved;
  }
  return body;
}
