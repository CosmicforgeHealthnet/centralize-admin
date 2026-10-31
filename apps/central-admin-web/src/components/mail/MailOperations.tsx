"use client";

// M9: Mail operations for mail administrators: health snapshot, alerts,
// usage and quotas, and retention runs (dry run first; execution needs the
// server flag and an MFA step-up). Shows counts and codes only.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import StepUpDialog from "@/components/marketing/email-marketing/StepUpDialog";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import api from "@/lib/api";
import {
  acknowledgeAlert,
  cancelRetention,
  executeRetention,
  opsAlerts,
  opsSnapshot,
  retentionCapabilities,
  retentionPolicies,
  retentionRuns,
  setQuota,
  startRetentionDryRun,
  usageReport,
} from "@/lib/mail-ops.service";
import type { RetentionRun } from "@/types/mail-ops.types";
import ProviderQuotaPanel from "@/components/it/ProviderQuotaPanel";

const card = "rounded-lg border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";
const ghost = "rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50";

const PURPOSE_LABEL: Record<string, string> = {
  STAFF_MAIL: "Staff mail",
  SUPPORT: "Support",
  MARKETING_BROADCAST: "Broadcasts",
  MARKETING_AUTOMATION: "Automation",
  MARKETING_CONFIRMATION: "Confirmations",
  INBOUND: "Received",
};

const ALERT_HELP: Record<string, string> = {
  MAIL_QUEUE_STALLED: "Jobs are due but not being picked up. Check that workers are running.",
  MAIL_WORKER_NOT_RUNNING: "No Mail worker has reported in recently, so incoming mail and delivery events are not being processed. The worker restarts automatically; if this persists, check the worker service.",
  MAIL_WORKER_QUEUE_UNSERVED: "A Mail queue the backend enables has no running worker (for example an emergency DENY rule pauses it). Incoming mail waits safely until it is served.",
  MAIL_WORKER_DISABLED: "The Mail worker is shut down by configuration (MAIL_WORKER_ENABLED=false). Nothing is processed until it is re-enabled.",
  MAIL_DEAD_LETTERS: "Jobs exhausted their retries. Review them before re-queueing anything.",
  MAIL_WEBHOOK_BACKLOG: "Provider events are waiting to be processed.",
  MAIL_SCAN_BACKLOG: "Attachments are waiting for a malware verdict.",
  MAIL_OUTCOME_UNKNOWN: "Some sends have no confirmed outcome. Do not resend without checking.",
  MAIL_BOUNCE_RATE_HIGH: "Bounce rate is above the threshold. Consider pausing sending.",
  MAIL_COMPLAINT_RATE_HIGH: "Spam complaints are above the threshold. Pause the brand's marketing.",
  MAIL_QUOTA_SOFT_LIMIT_REACHED: "A brand passed its daily soft limit.",
  MAIL_QUOTA_HARD_LIMIT_REACHED: "A brand reached its hard limit. Further sends are refused.",
  MAIL_EMERGENCY_STOP_ACTIVE: "An emergency stop is holding outgoing mail.",
  MAIL_RETENTION_RUN_FAILED: "A retention run failed. See the runs list.",
  MAIL_INTEGRATION_REJECTIONS: "A product integration is sending many rejected events.",
  MAIL_STORAGE_UNHEALTHY: "Private mail storage is unavailable.",
  MAIL_ENCRYPTION_UNAVAILABLE: "The mail encryption keyring is unavailable.",
  MAIL_INFRASTRUCTURE_VIOLATION: "Storage, key or scanner configuration violates deployment rules.",
  MAIL_PROVIDER_DEGRADED: "Many sends are backing off on provider rate limits or errors. Check the provider status.",
  MAIL_WEBHOOK_LAG_HIGH: "Provider events are processed slowly. Check the EVENTS and INBOUND workers.",
  MAIL_RECONCILIATION_STALE: "Inbound reconciliation has not completed recently. Check the INBOUND worker.",
  MAIL_INBOUND_WEBHOOKS_MISSED: "Some received emails arrived only through reconciliation: inbound webhooks were missed.",
};

const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  info: "bg-muted text-muted-foreground",
};

function seconds(value: number) {
  if (value < 120) return `${value}s`;
  if (value < 7200) return `${Math.round(value / 60)}m`;
  return `${Math.round(value / 3600)}h`;
}

function Health() {
  const snap = useQuery({ queryKey: ["mail", "ops", "snapshot"], queryFn: opsSnapshot, retry: false, refetchInterval: 60_000 });
  const data = snap.data;
  const tile = (label: string, value: string | number, warn = false) => (
    <div className={`rounded border p-2 ${warn ? "border-amber-500" : "border-border"}`}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-[14px] font-semibold">{value}</p>
    </div>
  );
  return (
    <section className={card} aria-labelledby="ops-health-h">
      <h2 id="ops-health-h" className="mb-2 text-[13px] font-semibold">Health</h2>
      <PermissionBoundary isLoading={snap.isLoading} error={snap.error} compact forbiddenMessage="Mail operations are available to mail administrators only.">
        {data && (
          <div className="flex flex-col gap-2">
            {(data.runtimeHalt?.staffMail || data.runtimeHalt?.marketing) && (
              <p role="alert" className="rounded bg-red-100 px-2 py-1 text-[12px] text-red-900 dark:bg-red-900/40 dark:text-red-100">
                Emergency stop active: {[data.runtimeHalt?.staffMail && "staff mail", data.runtimeHalt?.marketing && "marketing"].filter(Boolean).join(" and ")} is held. Queued mail is kept, not sent.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {tile("Active jobs", data.queue.active)}
              {tile("Oldest due job", seconds(Math.max(0, ...Object.values(data.queue.oldestDueSeconds))), Object.values(data.queue.oldestDueSeconds).some((v) => v > 900))}
              {tile("Dead letters (24h)", data.queue.deadLetters24h.reduce((s, r) => s + r.count, 0), data.queue.deadLetters24h.length > 0)}
              {tile("Unknown outcomes (24h)", data.delivery.outcomeUnknown24h, data.delivery.outcomeUnknown24h > 0)}
              {tile("Webhook backlog", data.webhooks.backlog, data.webhooks.oldestBacklogSeconds > 600)}
              {tile("Webhook failures (24h)", data.webhooks.failed24h)}
              {tile("Scan backlog", data.scanning.backlog, data.scanning.oldestBacklogSeconds > 1800)}
              {tile("Bounced (24h)", data.delivery.staff24h.BOUNCED ?? 0)}
              {data.provider && tile("Provider retries now", data.provider.retrying, data.provider.retrying > 0)}
              {data.webhookLag1h && tile("Webhook lag p95 (1h)", data.webhookLag1h.sample ? seconds(data.webhookLag1h.p95Seconds) : "—", data.webhookLag1h.p95Seconds > 300)}
              {data.reconciliation?.enabled && tile("Recovered by reconciliation (24h)", data.reconciliation.recovered24h, data.reconciliation.recovered24h > 0)}
              {data.reconciliation?.enabled && tile("Last reconciliation", data.reconciliation.lastSuccessAgeSeconds == null ? "Never" : `${seconds(data.reconciliation.lastSuccessAgeSeconds)} ago`, data.reconciliation.lastSuccessAgeSeconds == null)}
            </div>
            <p className="text-[10px] text-muted-foreground">Updated {formatFullDate(data.generatedAt)}</p>
          </div>
        )}
      </PermissionBoundary>
    </section>
  );
}

function Alerts() {
  const qc = useQueryClient();
  const [history, setHistory] = useState(false);
  const alerts = useQuery({ queryKey: ["mail", "ops", "alerts", history], queryFn: () => opsAlerts(history), retry: false, refetchInterval: 60_000 });
  const ack = useMutation({ mutationFn: acknowledgeAlert, onSuccess: () => qc.invalidateQueries({ queryKey: ["mail", "ops", "alerts"] }) });
  return (
    <section className={card} aria-labelledby="ops-alerts-h">
      <div className="mb-2 flex items-center gap-2">
        <h2 id="ops-alerts-h" className="text-[13px] font-semibold">Alerts</h2>
        <label className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Include resolved
        </label>
      </div>
      <PermissionBoundary isLoading={alerts.isLoading} error={alerts.error} compact>
        <ul className="flex flex-col gap-2 text-[12px]">
          {(alerts.data ?? []).length === 0 && <li className="text-muted-foreground">No open alerts.</li>}
          {(alerts.data ?? []).map((a) => (
            <li key={a.id} className="rounded border border-border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SEVERITY_TONE[a.severity]}`}>{a.severity}</span>
                <span className="font-semibold">{a.code}</span>
                <span className="text-muted-foreground">×{a.occurrences}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">Last seen {formatFullDate(a.lastSeenAt)}</span>
              </div>
              <p className="mt-1 text-muted-foreground">{ALERT_HELP[a.code] ?? "See the operations runbook."}</p>
              {a.resolvedAt ? <p className="text-[11px] text-muted-foreground">Resolved {formatFullDate(a.resolvedAt)}</p> : a.acknowledgedAt ? (
                <p className="text-[11px] text-muted-foreground">Acknowledged {formatFullDate(a.acknowledgedAt)}</p>
              ) : (
                <button type="button" className={`${ghost} mt-1`} disabled={ack.isPending} onClick={() => ack.mutate(a.id)} aria-label={`Acknowledge ${a.code}`}>Acknowledge</button>
              )}
            </li>
          ))}
        </ul>
      </PermissionBoundary>
    </section>
  );
}

function Usage() {
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ["mail", "ops", "usage"], queryFn: () => usageReport(30), retry: false });
  const [form, setForm] = useState({ organizationId: "", purpose: "STAFF_MAIL", dailySoftLimit: "", dailyHardLimit: "", monthlyHardLimit: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const toNumber = (value: string) => (value.trim() ? Number(value) : null);
  const save = useMutation({
    mutationFn: () => setQuota({ organizationId: form.organizationId, purpose: form.purpose, dailySoftLimit: toNumber(form.dailySoftLimit), dailyHardLimit: toNumber(form.dailyHardLimit), monthlyHardLimit: toNumber(form.monthlyHardLimit) }),
    onSuccess: () => { setMsg("Limit saved."); qc.invalidateQueries({ queryKey: ["mail", "ops", "usage"] }); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const data = report.data;
  const orgs = new Map((data?.summary ?? []).map((row) => [row.organizationId, row.organization.name ?? row.organizationId]));
  const limitFor = (organizationId: string, purpose: string) => data?.limits.find((l) => l.organizationId === organizationId && l.purpose === purpose);
  return (
    <section className={card} aria-labelledby="ops-usage-h">
      <h2 id="ops-usage-h" className="mb-2 text-[13px] font-semibold">Usage and limits (last 30 days)</h2>
      <PermissionBoundary isLoading={report.isLoading} error={report.error} compact>
        {data && (
          <>
            <p className="mb-2 text-[11px] text-muted-foreground">{data.cost.currency ? `Estimated cost in ${data.cost.currency} from ${data.cost.source}.` : data.cost.note}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <caption className="sr-only">Usage by brand and purpose</caption>
                <thead><tr className="text-muted-foreground"><th scope="col" className="py-1">Brand</th><th scope="col">Purpose</th><th scope="col">Accepted</th><th scope="col">Received</th><th scope="col">Rejected</th><th scope="col">Daily soft / hard</th>{data.cost.currency && <th scope="col">Est. cost</th>}</tr></thead>
                <tbody>
                  {data.summary.length === 0 && <tr><td colSpan={7} className="py-1 text-muted-foreground">No usage recorded.</td></tr>}
                  {data.summary.map((row) => {
                    const limit = limitFor(row.organizationId, row.purpose);
                    return (
                      <tr key={`${row.organizationId}-${row.purpose}`} className="border-t border-border">
                        <td className="py-1">{row.organization.name ?? row.organizationId}</td>
                        <td>{PURPOSE_LABEL[row.purpose] ?? row.purpose}</td>
                        <td>{row.accepted}</td>
                        <td>{row.received}</td>
                        <td>{row.rejected}</td>
                        <td>{limit ? `${limit.dailySoftLimit ?? "—"} / ${limit.dailyHardLimit ?? "—"}` : "No limit"}</td>
                        {data.cost.currency && <td>{row.estimatedCost ?? "—"}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </PermissionBoundary>
      <form className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="col-span-2 text-[11px] text-muted-foreground">Brand
          <select value={form.organizationId} onChange={(e) => setForm({ ...form, organizationId: e.target.value })} className={input} required>
            <option value="">Select…</option>
            {[...orgs.entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">Purpose
          <select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} className={input}>
            {Object.entries(PURPOSE_LABEL).filter(([key]) => key !== "INBOUND").map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">Daily soft
          <input inputMode="numeric" value={form.dailySoftLimit} onChange={(e) => setForm({ ...form, dailySoftLimit: e.target.value })} className={input} />
        </label>
        <label className="text-[11px] text-muted-foreground">Daily hard
          <input inputMode="numeric" value={form.dailyHardLimit} onChange={(e) => setForm({ ...form, dailyHardLimit: e.target.value })} className={input} />
        </label>
        <label className="text-[11px] text-muted-foreground">Monthly hard
          <input inputMode="numeric" value={form.monthlyHardLimit} onChange={(e) => setForm({ ...form, monthlyHardLimit: e.target.value })} className={input} />
        </label>
        <button type="submit" className={`${btn} col-span-2 justify-self-start`} disabled={!form.organizationId || save.isPending}>Save limit</button>
      </form>
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}

const COUNT_LABEL: Record<string, string> = {
  candidates: "Candidates", held: "Protected by legal hold", skippedActive: "Skipped (open case / sending)", archived: "Archived",
  purgedThreads: "Threads purged", purgedMessages: "Messages purged", purgedAttachments: "Attachments purged", storageObjectsRemoved: "Stored objects removed",
  storageRemoveFailed: "Object removals failed", redacted: "Payloads redacted", deleted: "Rows deleted", heldIntegrations: "Integrations under hold",
};

function RunCounts({ run }: { run: RetentionRun }) {
  const entries = Object.entries(run.counts).filter(([key]) => COUNT_LABEL[key]);
  if (!entries.length) return <span className="text-muted-foreground">—</span>;
  return <span>{entries.map(([key, value]) => `${COUNT_LABEL[key]}: ${value}`).join(" · ")}</span>;
}

function Retention() {
  const qc = useQueryClient();
  const caps = useQuery({ queryKey: ["mail", "ops", "retention", "caps"], queryFn: retentionCapabilities, retry: false });
  const policies = useQuery({ queryKey: ["mail", "ops", "retention", "policies"], queryFn: retentionPolicies, retry: false });
  const runs = useQuery({ queryKey: ["mail", "ops", "retention", "runs"], queryFn: retentionRuns, retry: false, refetchInterval: 15_000 });
  const [target, setTarget] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [executing, setExecuting] = useState<RetentionRun | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail", "ops", "retention", "runs"] });
  const start = useMutation({
    mutationFn: () => startRetentionDryRun(target.startsWith("policy:") ? { policyId: target.slice(7) } : { category: target.slice(9) }),
    onSuccess: () => { setMsg("Dry run queued. It only counts; nothing is changed."); refresh(); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const cancel = useMutation({ mutationFn: cancelRetention, onSuccess: refresh, onError: (e) => setMsg(classifyMailError(e).message) });
  const enabled = caps.data?.executionEnabled ?? false;
  const executedDryRuns = new Set((runs.data ?? []).filter((r) => r.mode === "EXECUTE").map((r) => r.dryRunId));
  return (
    <section className={card} aria-labelledby="ops-retention-h">
      <h2 id="ops-retention-h" className="mb-1 text-[13px] font-semibold">Retention</h2>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Every run starts as a dry run that only counts. {enabled ? `Executing a completed dry run (valid ${caps.data?.dryRunValidHours}h) permanently removes content and needs a 2FA code.` : "Execution is not enabled in this environment."} Legal holds are always respected.
      </p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (target) start.mutate(); }}>
        <label className="min-w-[220px] flex-1 text-[11px] text-muted-foreground">Policy or system category
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={input}>
            <option value="">Select…</option>
            {(policies.data ?? []).filter((p) => p.enabled).map((p) => <option key={p.id} value={`policy:${p.id}`}>{p.name} ({p.action.toLowerCase()} after {p.retainDays} days)</option>)}
            {(caps.data?.systemCategories ?? []).map((c) => (
              <option key={c.category} value={`category:${c.category}`} disabled={!c.retainDays}>{c.category} ({c.retainDays ? `${c.action.toLowerCase()} after ${c.retainDays} days` : "no period configured"})</option>
            ))}
          </select>
        </label>
        <button type="submit" className={btn} disabled={!target || start.isPending}>Start dry run</button>
      </form>
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
      <PermissionBoundary isLoading={runs.isLoading} error={runs.error} compact>
        <ul className="mt-3 flex flex-col gap-2 text-[12px]">
          {(runs.data ?? []).length === 0 && <li className="text-muted-foreground">No retention runs yet.</li>}
          {(runs.data ?? []).map((run) => (
            <li key={run.id} className="rounded border border-border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{run.mode === "DRY_RUN" ? "Dry run" : "Execution"}</span>
                <span>{run.category === "POLICY" ? (policies.data ?? []).find((p) => p.id === run.policyId)?.name ?? "Policy" : run.category}</span>
                <span className="text-muted-foreground">{run.action.toLowerCase()} before {formatFullDate(run.cutoff)}</span>
                <span className="ml-auto font-semibold">{run.status}{run.errorCode ? ` (${run.errorCode})` : ""}</span>
              </div>
              <p className="mt-1 text-[11px]"><RunCounts run={run} /></p>
              <div className="mt-1 flex gap-2">
                {["QUEUED", "RUNNING"].includes(run.status) && <button type="button" className={ghost} onClick={() => cancel.mutate(run.id)}>Cancel</button>}
                {run.mode === "DRY_RUN" && run.status === "COMPLETED" && enabled && !executedDryRuns.has(run.id) && (
                  <button type="button" className="rounded-md bg-red-700 px-3 py-1.5 text-[12px] font-semibold text-white" onClick={() => setExecuting(run)}>Execute… (permanent)</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </PermissionBoundary>
      {executing && (
        <StepUpDialog
          purpose="MAIL_RETENTION_EXECUTE"
          title={`Execute retention (${executing.counts.candidates ?? 0} candidates)`}
          onCancel={() => setExecuting(null)}
          onVerified={async (stepUpId) => {
            const run = executing;
            setExecuting(null);
            try {
              await executeRetention(run.id, stepUpId);
              setMsg("Execution queued.");
              refresh();
            } catch (e) {
              setMsg(classifyMailError(e).message);
            }
          }}
        />
      )}
    </section>
  );
}

// ---- Final gap 5: durable storage deletion queue (migration 37) ----
interface StorageDeletionRow { id: string; keyHash: string; purpose: string; reason: string; status: string; attempts: number; maxAttempts: number; nextAttemptAt: string | null; lastError: string | null; createdAt: string; completedAt: string | null }
interface StorageDeletionList { counts: Record<string, number>; due: number; oldestDueSeconds: number; items: StorageDeletionRow[]; nextCursor: string | null }
// DSAR erasure, IT quarantine and retention deletions can never be cancelled.
const PROTECTED_DELETION_PURPOSES = new Set(["DSAR", "QUARANTINE", "RETENTION"]);

function StorageDeletions() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("DEAD");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [requeueing, setRequeueing] = useState<StorageDeletionRow | null>(null);
  const [cancelling, setCancelling] = useState<StorageDeletionRow | null>(null);
  const queue = useQuery({
    queryKey: ["mail", "ops", "storage-deletions", status],
    queryFn: async () => (await api.get<{ data: StorageDeletionList }>("/api/mail/v1/admin/storage-deletions", { params: status ? { status } : {} })).data.data,
    retry: false,
    refetchInterval: 60_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail", "ops", "storage-deletions"] });
  const reasonOk = reason.trim().length >= 5;
  const data = queue.data;
  return (
    <section className={card} aria-labelledby="ops-deletions-h">
      <h2 id="ops-deletions-h" className="mb-1 text-[13px] font-semibold">Storage deletion queue</h2>
      <p className="mb-2 text-[11px] text-muted-foreground">Stored mail objects are deleted through a durable queue: failures retry with backoff, then stop as dead for review. Objects still in use or under legal hold are never deleted. Only a short key fingerprint is shown.</p>
      <PermissionBoundary isLoading={queue.isLoading} error={queue.error} compact forbiddenMessage="Mail operations are available to mail administrators only.">
        {data && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {["PENDING", "RUNNING", "DONE", "DEAD", "CANCELLED"].map((key) => (
                <div key={key} className={`rounded border p-2 ${key === "DEAD" && data.counts[key] ? "border-amber-500" : "border-border"}`}>
                  <p className="text-[10px] text-muted-foreground">{key.toLowerCase()}</p>
                  <p className="text-[14px] font-semibold">{data.counts[key] ?? 0}</p>
                </div>
              ))}
              <div className="rounded border border-border p-2">
                <p className="text-[10px] text-muted-foreground">Due now</p>
                <p className="text-[14px] font-semibold">{data.due}{data.due ? ` (${seconds(data.oldestDueSeconds)})` : ""}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-[11px] text-muted-foreground">Show
                <select value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
                  <option value="DEAD">Dead</option><option value="PENDING">Pending</option><option value="CANCELLED">Cancelled</option><option value="DONE">Done</option><option value="">All</option>
                </select>
              </label>
              <label className="min-w-[220px] flex-1 text-[11px] text-muted-foreground">Reason for requeue / cancel (audited)
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={input} />
              </label>
            </div>
            <ul className="flex flex-col gap-1 text-[12px]">
              {data.items.length === 0 && <li className="text-muted-foreground">No deletions with this status.</li>}
              {data.items.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 rounded border border-border p-2">
                  <span className="font-mono text-[11px]">#{row.keyHash}</span>
                  <span>{row.reason.replace(/_/g, " ").toLowerCase()}</span>
                  <span className="font-semibold">{row.status}</span>
                  <span className="text-muted-foreground">{row.attempts}/{row.maxAttempts} attempts{row.lastError ? ` · ${row.lastError}` : ""}</span>
                  <span className="text-[11px] text-muted-foreground">{formatFullDate(row.createdAt)}</span>
                  <span className="ml-auto flex gap-2">
                    {(row.status === "DEAD" || (row.status === "CANCELLED" && (row.lastError === "HELD" || row.lastError === "CANCELLED_BY_ADMIN"))) && (
                      <button type="button" className={ghost} disabled={!reasonOk} onClick={() => setRequeueing(row)} aria-label={`Requeue deletion ${row.keyHash}`}>Requeue…</button>
                    )}
                    {row.status === "PENDING" && !PROTECTED_DELETION_PURPOSES.has(row.purpose) && (
                      <button type="button" className={ghost} disabled={!reasonOk} onClick={() => setCancelling(row)} aria-label={`Cancel deletion ${row.keyHash}`}>Cancel…</button>
                    )}
                    {row.status === "PENDING" && PROTECTED_DELETION_PURPOSES.has(row.purpose) && (
                      <span className="text-[11px] text-muted-foreground">Required by {row.purpose.toLowerCase()}: cannot be cancelled</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </PermissionBoundary>
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
      {cancelling && (
        <StepUpDialog
          purpose="MAIL_STORAGE_DELETION_CANCEL"
          title={`Cancel deletion #${cancelling.keyHash}`}
          onCancel={() => setCancelling(null)}
          onVerified={async (stepUpId) => {
            const row = cancelling;
            setCancelling(null);
            try {
              await api.post(`/api/mail/v1/admin/storage-deletions/${row.id}/cancel`, { reason: reason.trim(), stepUpId });
              setMsg("Deletion cancelled. The stored object is kept.");
              refresh();
            } catch (e) {
              setMsg(classifyMailError(e).message);
            }
          }}
        />
      )}
      {requeueing && (
        <StepUpDialog
          purpose="MAIL_STORAGE_DELETION_REQUEUE"
          title={`Requeue deletion #${requeueing.keyHash}`}
          onCancel={() => setRequeueing(null)}
          onVerified={async (stepUpId) => {
            const row = requeueing;
            setRequeueing(null);
            try {
              await api.post(`/api/mail/v1/admin/storage-deletions/${row.id}/requeue`, { reason: reason.trim(), stepUpId });
              setMsg("Deletion requeued.");
              refresh();
            } catch (e) {
              setMsg(classifyMailError(e).message);
            }
          }}
        />
      )}
    </section>
  );
}

export default function MailOperations() {
  return (
    <div className="flex flex-col gap-4">
      <Health />
      <Alerts />
      <Usage />
      <ProviderQuotaPanel />
      <Retention />
      <StorageDeletions />
    </div>
  );
}
