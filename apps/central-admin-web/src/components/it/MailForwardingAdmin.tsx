"use client";

// IT > Mail Administration > Forwarding & recovery: approve/reject
// forwarding requests (external targets need MFA step-up), turn forwarding
// off, watch body-search index freshness, and requeue dead-lettered inbound
// or event jobs (MFA step-up). Never shows message content.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import StepUpDialog from "@/components/marketing/email-marketing/StepUpDialog";
import api from "@/lib/api";
import {
  approveForwarding,
  classifyMailError,
  disableForwarding,
  fetchForwardingRequests,
  fetchSearchIndexStatus,
  rejectForwarding,
  startSearchBackfill,
} from "@/lib/mail.service";
import type { ForwardingRule } from "@/types/mail.types";

const card = "rounded-xl border border-border bg-card p-4";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";
const ghost = "rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50";
const th = "py-1.5 pr-3 text-left text-[11px] font-semibold text-muted-foreground";
const td = "py-1.5 pr-3 align-top text-[12px]";
const FORBIDDEN = "Mail administration is available to mail administrators only.";
const REQUEUEABLE = new Set(["PROCESS_INBOUND", "PROCESS_DELIVERY_EVENT", "RECONCILE_INBOUND", "OPS_EVALUATE", "SEARCH_INDEX_BACKFILL"]);

interface JobRow { id: string; queue: string; kind: string; status: string; attemptCount: number; maxAttempts: number; lastErrorCode: string | null; updatedAt: string }
type Pending = { title: string; purpose: string; run: (stepUpId: string) => Promise<unknown> };

export default function MailForwardingAdmin({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState("PENDING_APPROVAL");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const forwarding = useQuery({ queryKey: ["mail", "admin", "forwarding", status], queryFn: () => fetchForwardingRequests(status || undefined), retry: false });
  const search = useQuery({ queryKey: ["mail", "admin", "search-index"], queryFn: fetchSearchIndexStatus, retry: false });
  const deadLetters = useQuery({
    queryKey: ["mail", "admin", "jobs", "DEAD_LETTER"],
    queryFn: async () => (await api.get<{ data: JobRow[] }>("/api/mail/v1/admin/jobs", { params: { status: "DEAD_LETTER" } })).data.data,
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail", "admin"] });
  const onError = (e: unknown) => setMsg(classifyMailError(e).message);
  const decide = useMutation({
    mutationFn: ({ rule, approve, stepUpId }: { rule: ForwardingRule; approve: boolean; stepUpId?: string }) => (approve ? approveForwarding(rule.id, { stepUpId }) : rejectForwarding(rule.id, {})),
    onSuccess: (_data, vars) => { setMsg(vars.approve ? "Forwarding approved." : "Request rejected."); refresh(); },
    onError,
  });
  const disable = useMutation({ mutationFn: (rule: ForwardingRule) => disableForwarding(rule.id), onSuccess: () => { setMsg("Forwarding turned off."); refresh(); }, onError });
  const backfill = useMutation({ mutationFn: startSearchBackfill, onSuccess: () => { setMsg("Index backfill queued."); refresh(); }, onError });

  const approve = (rule: ForwardingRule) => {
    if (rule.targetKind === "EXTERNAL") setPending({ title: `Approve forwarding to ${rule.targetAddress}`, purpose: "MAIL_FORWARDING_APPROVE", run: (stepUpId) => decide.mutateAsync({ rule, approve: true, stepUpId }) });
    else decide.mutate({ rule, approve: true });
  };
  const requeue = (job: JobRow) => {
    const reason = window.prompt("Why is it safe to retry this job now? (recorded in the audit log)");
    if (!reason || reason.trim().length < 5) return;
    setPending({ title: `Requeue ${job.kind}`, purpose: "MAIL_JOB_REQUEUE", run: async (stepUpId) => (await api.post(`/api/mail/v1/admin/jobs/${job.id}/requeue`, { reason: reason.trim(), stepUpId })).data });
  };

  return (
    <>
      <section className={card} aria-labelledby="fwd-admin-h">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 id="fwd-admin-h" className="text-[13px] font-semibold">Forwarding requests</h3>
          <label className="ml-auto text-[11px] text-muted-foreground">Show
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="ml-1 rounded border border-border bg-card px-2 py-1 text-[12px]">
              <option value="PENDING_APPROVAL">Waiting for approval</option><option value="ACTIVE">Active</option><option value="DISABLED">Off</option><option value="REJECTED">Rejected</option><option value="">All</option>
            </select>
          </label>
        </div>
        <p className="mb-2 text-[11px] text-muted-foreground">You cannot approve your own request. External targets must be on the allowed-domain policy list and need two-factor confirmation.</p>
        <PermissionBoundary isLoading={forwarding.isLoading} error={forwarding.error} compact forbiddenMessage={FORBIDDEN}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <caption className="sr-only">Forwarding requests</caption>
              <thead><tr><th className={th}>Requested</th><th className={th}>Mailbox</th><th className={th}>Forward to</th><th className={th}>Reason</th><th className={th}>Status</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {(forwarding.data ?? []).length === 0 && <tr><td className={td} colSpan={6}>Nothing to show.</td></tr>}
                {(forwarding.data ?? []).map((rule) => (
                  <tr key={rule.id} className="border-b border-border/60">
                    <td className={td}>{formatFullDate(rule.requestedAt)}</td>
                    <td className={td}>{rule.mailbox?.name ?? rule.mailboxId}</td>
                    <td className={`${td} break-all`}>{rule.targetAddress} <span className="text-muted-foreground">({rule.targetKind.toLowerCase()})</span></td>
                    <td className={td}>{rule.reason}</td>
                    <td className={td}>{rule.status.replace(/_/g, " ").toLowerCase()}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      {canEdit && rule.status === "PENDING_APPROVAL" && (
                        <>
                          <button type="button" className={btn} disabled={decide.isPending} onClick={() => approve(rule)}>Approve</button>{" "}
                          <button type="button" className={ghost} disabled={decide.isPending} onClick={() => decide.mutate({ rule, approve: false })}>Reject</button>
                        </>
                      )}
                      {canEdit && rule.status === "ACTIVE" && <button type="button" className={ghost} disabled={disable.isPending} onClick={() => disable.mutate(rule)}>Turn off</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PermissionBoundary>
      </section>

      <section className={card} aria-labelledby="search-admin-h">
        <h3 id="search-admin-h" className="mb-2 text-[13px] font-semibold">Body search index</h3>
        <PermissionBoundary isLoading={search.isLoading} error={search.error} compact forbiddenMessage={FORBIDDEN}>
          {search.data && !search.data.enabled && <p className="text-[12px] text-muted-foreground">Body search is off. Staff can search sender, recipients, subject, labels and dates.</p>}
          {search.data?.enabled && (
            <div className="flex flex-wrap items-center gap-3 text-[12px]">
              <span>Messages waiting to be indexed: <strong>{search.data.unindexed ?? 0}</strong></span>
              {search.data.oldestUnindexedAt && <span className="text-muted-foreground">oldest {formatFullDate(search.data.oldestUnindexedAt)}</span>}
              <span className="text-muted-foreground">key version {search.data.activeKeyVersion}</span>
              {canEdit && <button type="button" className={ghost} disabled={backfill.isPending} onClick={() => backfill.mutate()}>Index now</button>}
            </div>
          )}
        </PermissionBoundary>
      </section>

      <section className={card} aria-labelledby="dead-admin-h">
        <h3 id="dead-admin-h" className="mb-2 text-[13px] font-semibold">Dead-lettered jobs</h3>
        <p className="mb-2 text-[11px] text-muted-foreground">Inbound and event jobs can be retried after the cause is fixed. Outbound sends are never replayed blindly: their outcome may be unknown.</p>
        <PermissionBoundary isLoading={deadLetters.isLoading} error={deadLetters.error} compact forbiddenMessage={FORBIDDEN}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <caption className="sr-only">Dead-lettered jobs</caption>
              <thead><tr><th className={th}>Updated</th><th className={th}>Kind</th><th className={th}>Attempts</th><th className={th}>Last error</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {(deadLetters.data ?? []).length === 0 && <tr><td className={td} colSpan={5}>No dead letters.</td></tr>}
                {(deadLetters.data ?? []).map((job) => (
                  <tr key={job.id} className="border-b border-border/60">
                    <td className={td}>{formatFullDate(job.updatedAt)}</td>
                    <td className={td}><code>{job.kind}</code></td>
                    <td className={td}>{job.attemptCount}/{job.maxAttempts}</td>
                    <td className={td}>{job.lastErrorCode ?? "—"}</td>
                    <td className={td}>{canEdit && REQUEUEABLE.has(job.kind) && <button type="button" className={ghost} onClick={() => requeue(job)}>Retry</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PermissionBoundary>
      </section>

      {msg && <p role="status" className="text-[11px] text-muted-foreground">{msg}</p>}
      {pending && (
        <StepUpDialog
          purpose={pending.purpose}
          title={pending.title}
          onCancel={() => setPending(null)}
          onVerified={async (stepUpId) => {
            const action = pending;
            setPending(null);
            try {
              await action.run(stepUpId);
              setMsg("Done.");
              refresh();
            } catch (e) {
              setMsg(classifyMailError(e).message);
            }
          }}
        />
      )}
    </>
  );
}
