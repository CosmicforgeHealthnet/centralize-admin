"use client";

// Final gap 2: provider re-subscription queue. A request is opened only when
// a contact who unsubscribed through the provider completes a verified double
// opt-in. Brand approvers approve (MFA step-up) or refuse; when automatic
// provider re-subscription is not enabled, the operator completes it at the
// provider and confirms it here (MFA step-up). Local consent stays the source
// of truth; the provider is read back before anything is marked applied.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import { approveResubscription, confirmResubscriptionManually, fetchResubscriptions, refuseResubscription } from "@/lib/mail-marketing.service";
import type { MarketingOrganization, ProviderResubscription } from "@/types/mail-marketing.types";
import StepUpDialog from "./StepUpDialog";
import { EmBadge, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

const STATUS_HELP: Record<string, string> = {
  PENDING_APPROVAL: "Waiting for a brand approver.",
  APPROVED: "Approved; the provider update is being applied (retried automatically).",
  APPLIED: "The provider confirmed the contact is subscribed again.",
  UNSUPPORTED: "Automatic provider re-subscription is off. Complete it at the provider, then confirm here.",
  FAILED: "The provider did not confirm the re-subscription.",
  REFUSED: "Refused. The contact stays unsubscribed at the provider.",
  CANCELLED: "Cancelled.",
};

const FILTERS = ["", "PENDING_APPROVAL", "APPROVED", "UNSUPPORTED", "FAILED", "APPLIED", "REFUSED"];

type Pending = { kind: "approve" | "confirm"; item: ProviderResubscription } | null;

export default function ResubscriptionsPanel({ org }: { org: MarketingOrganization }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [refusing, setRefusing] = useState<ProviderResubscription | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const key = ["mail", "marketing", org.id, "resubscriptions", status];
  const q = useQuery({ queryKey: key, queryFn: () => fetchResubscriptions(org.id, status ? { status } : {}), gcTime: 300000, retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "resubscriptions"] });
  const refuse = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => refuseResubscription(org.id, id, text),
    onSuccess: () => { setRefusing(null); setReason(""); setMsg({ text: "Re-subscription refused.", tone: "info" }); refresh(); },
    onError: (e) => setMsg({ text: classifyMailError(e).message, tone: "error" }),
  });
  const notReady = classifyMailError(q.error).code === "MAIL_FEATURE_NOT_READY";

  const onVerified = async (stepUpId: string) => {
    if (!pending) return;
    try {
      const result = pending.kind === "approve"
        ? await approveResubscription(org.id, pending.item.id, stepUpId)
        : await confirmResubscriptionManually(org.id, pending.item.id, stepUpId);
      setMsg({ text: `Re-subscription is now ${result.status.replace(/_/g, " ").toLowerCase()}. ${STATUS_HELP[result.status] ?? ""}`, tone: result.status === "FAILED" ? "error" : "info" });
    } catch (e) {
      const info = classifyMailError(e);
      const reasons = Array.isArray(info.detail?.reasons) ? ` (${(info.detail?.reasons as string[]).join(", ")})` : "";
      setMsg({ text: `${info.message}${reasons}`, tone: "error" });
    }
    setPending(null);
    refresh();
  };

  if (notReady) {
    return <p role="status" className="text-[12px] text-muted-foreground">Provider re-subscription is available after the latest Mail database update is applied.</p>;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="resubscriptions-panel">
      <p className="text-[12px] text-muted-foreground">
        A contact who unsubscribed through the provider&apos;s link stays unsubscribed there even after confirming again here. When such a contact completes a new double opt-in, a request appears below.
        Complaints, hard bounces and suppressed addresses are never re-subscribed.
      </p>
      {q.data && !q.data.flags.providerResubscribeEnabled && (
        <p role="note" className="rounded-md border border-amber-200 bg-amber-50 p-2 text-[12px] text-amber-800">
          Automatic provider re-subscription is turned off (the provider does not document it). Approved requests become &ldquo;unsupported&rdquo;: re-add the contact with the provider&apos;s support or dashboard, then use Confirm manually.
        </p>
      )}
      <div className="flex items-end gap-2">
        <EmField label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={emInput} aria-label="Filter re-subscriptions by status">
            {FILTERS.map((value) => <option key={value || "all"} value={value}>{value ? value.replace(/_/g, " ").toLowerCase() : "All"}</option>)}
          </select>
        </EmField>
      </div>
      <EmMessage message={msg?.text ?? null} tone={msg?.tone} />
      <PermissionBoundary isLoading={q.isLoading} error={q.error} retry={() => q.refetch()} compact>
        {(q.data?.items ?? []).length === 0 ? (
          <p role="status" className="p-3 text-center text-[12px] text-muted-foreground">No re-subscription requests.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <caption className="sr-only">Provider re-subscription requests</caption>
              <thead className="text-muted-foreground"><tr><th className="py-1">Contact</th><th>Status</th><th>Provider state</th><th>Evidence</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {(q.data?.items ?? []).map((item) => (
                  <tr key={item.id} className="border-t border-border align-top">
                    <td className="py-1.5">{item.email ?? item.contactId}<div className="text-muted-foreground">{item.topic}</div></td>
                    <td>
                      <EmBadge value={item.status} />
                      <div className="max-w-[260px] text-muted-foreground">{STATUS_HELP[item.status]}</div>
                      {item.lastError && item.status !== "APPLIED" && <div className="text-muted-foreground">Reason: {item.lastError}</div>}
                      {item.status === "APPROVED" && item.nextAttemptAt && <div className="text-muted-foreground">Next attempt {formatFullDate(item.nextAttemptAt)} (attempt {item.attempts})</div>}
                    </td>
                    <td>{item.providerState ? <><EmBadge value={item.providerState.state} />{item.providerState.reason && <div className="text-muted-foreground">{item.providerState.reason.replace(/_/g, " ").toLowerCase()}</div>}</> : "—"}</td>
                    <td className="text-muted-foreground">
                      Double opt-in confirmed {formatFullDate(item.evidence.confirmedAt)}
                      <div>{item.evidence.source} · policy {item.evidence.policyVersion}</div>
                    </td>
                    <td className="text-right">
                      {org.canApprove && (
                        <div className="flex flex-col items-end gap-1">
                          {item.status === "PENDING_APPROVAL" && <button type="button" className={emBtn} onClick={() => setPending({ kind: "approve", item })}>Approve</button>}
                          {(item.status === "UNSUPPORTED" || item.status === "FAILED") && <button type="button" className={emBtn} onClick={() => setPending({ kind: "confirm", item })}>Confirm manually</button>}
                          {["PENDING_APPROVAL", "APPROVED", "UNSUPPORTED", "FAILED"].includes(item.status) && <button type="button" className={emBtnOutline} onClick={() => { setRefusing(item); setReason(""); }}>Refuse</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PermissionBoundary>
      {refusing && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
          aria-label="Refuse re-subscription"
          onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) refuse.mutate({ id: refusing.id, text: reason.trim() }); }}
        >
          <EmField label={`Reason for refusing ${refusing.email ?? "this contact"}`}>
            <input value={reason} onChange={(e) => setReason(e.target.value)} className={emInput} maxLength={200} required />
          </EmField>
          <button type="submit" className={emBtn} disabled={reason.trim().length < 3 || refuse.isPending}>Refuse</button>
          <button type="button" className={emBtnOutline} onClick={() => setRefusing(null)}>Cancel</button>
        </form>
      )}
      {pending && (
        <StepUpDialog
          purpose={pending.kind === "approve" ? "MARKETING_RESUBSCRIBE_APPROVE" : "MARKETING_RESUBSCRIBE_CONFIRM"}
          title={pending.kind === "approve" ? "Approve provider re-subscription" : "Confirm provider re-subscription"}
          onVerified={onVerified}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
