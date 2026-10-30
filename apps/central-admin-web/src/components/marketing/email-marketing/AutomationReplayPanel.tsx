"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import { fetchAutomationRecovery, fetchAutomationReplays, requestAutomationReplay } from "@/lib/mail-marketing.service";
import type { Automation, AutomationReplayResponse, AutomationReplayScope, MarketingOrganization } from "@/types/mail-marketing.types";
import StepUpDialog from "./StepUpDialog";
import { EmBadge, EmCard, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

interface Candidate {
  scope: AutomationReplayScope;
  targetId: string;
  label: string;
  status: string;
  detail: string;
}

const human = (code?: string | null) => (code ? code.toLowerCase().replace(/_/g, " ") : "");

/** Failed / interrupted / dead-lettered runs: dry run -> confirm (step-up) -> result. */
export default function AutomationReplayPanel({ org, automation }: { org: MarketingOrganization; automation: Automation }) {
  const qc = useQueryClient();
  const key = ["mail", "marketing", org.id, "automation", automation.id, "recovery"];
  const recoveryQ = useQuery({ queryKey: key, queryFn: () => fetchAutomationRecovery(org.id, automation.id), retry: false });
  const historyQ = useQuery({ queryKey: [...key, "history"], queryFn: () => fetchAutomationReplays(org.id, automation.id), retry: false });
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [plan, setPlan] = useState<AutomationReplayResponse | null>(null);
  const [executed, setExecuted] = useState<AutomationReplayResponse | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);

  const r = recoveryQ.data;
  const candidates: Candidate[] = r
    ? [
        ...r.failedStepRuns.items.map((run) => ({ scope: "STEP_RUN" as const, targetId: run.id, label: `Step ${run.stepId} · ${run.recipientEmail ?? ""}`, status: run.status, detail: human(run.errorCode) })),
        ...r.interruptedStepRuns.items.map((run) => ({ scope: "STEP_RUN" as const, targetId: run.id, label: `Step ${run.stepId} · ${run.recipientEmail ?? ""}`, status: "INTERRUPTED", detail: "worker lost while sending" })),
        ...r.deadLetterJobs.items.map((job) => ({ scope: "DEAD_LETTER_JOB" as const, targetId: job.id, label: `Job ${job.id.slice(0, 8)} · step #${job.sequence}`, status: job.status, detail: `${job.attemptCount} attempts · ${human(job.lastErrorCode)}` })),
        ...r.failedEnrollments.items.map((e) => ({ scope: "ENROLLMENT" as const, targetId: e.id, label: `Enrollment ${e.id.slice(0, 8)} · step ${e.currentStepId ?? "–"}`, status: e.status, detail: human(e.exitReason) })),
        ...r.stalledEnrollments.items.map((e) => ({ scope: "ENROLLMENT" as const, targetId: e.id, label: `Enrollment ${e.id.slice(0, 8)} · step ${e.currentStepId ?? "–"}`, status: "STALLED", detail: "no queued job" })),
      ]
    : [];
  const truncated = r && [r.failedStepRuns, r.interruptedStepRuns, r.deadLetterJobs, r.failedEnrollments, r.stalledEnrollments].some((page) => page.more);

  const onErr = (err: unknown) => {
    const info = classifyMailError(err);
    const detail = info.detail as { reason?: string; explanation?: string } | undefined;
    setMsg({ text: detail?.explanation ? `${info.message} ${detail.explanation}` : detail?.reason ? `${info.message} (${human(detail.reason)})` : info.message, tone: "error" });
  };
  const dryRun = useMutation({
    mutationFn: (candidate: Candidate) => requestAutomationReplay(org.id, automation.id, { scope: candidate.scope, targetId: candidate.targetId, mode: "DRY_RUN", reason: reason.trim() }),
    onMutate: () => { setMsg(null); setPlan(null); setExecuted(null); },
    onSuccess: (res) => { setPlan(res); qc.invalidateQueries({ queryKey: [...key, "history"] }); },
    onError: onErr,
  });
  const execute = useMutation({
    mutationFn: (stepUpId: string) => requestAutomationReplay(org.id, automation.id, { scope: selected!.scope, targetId: selected!.targetId, mode: "EXECUTE", reason: reason.trim(), stepUpId, acknowledgeUnknownOutcome: acknowledged || undefined }),
    onSuccess: (res) => {
      setExecuted(res);
      setPlan(null);
      setMsg({ text: "Replay executed: the step is queued and the worker re-checks consent, suppression, caps and status before sending.", tone: "info" });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "automation", automation.id] });
    },
    onError: (err) => { onErr(err); qc.invalidateQueries({ queryKey: [...key, "history"] }); },
  });

  const p = plan?.plan;
  const canExecute = org.canApprove && p && !p.refusal && (!p.requiresAcknowledgement || acknowledged) && reason.trim().length >= 5;

  return (
    <EmCard title="Replay & recovery" id="au-replay">
      <PermissionBoundary isLoading={recoveryQ.isLoading} error={recoveryQ.error} compact>
        <div className="flex flex-col gap-3 text-[12px]">
          <p className="text-muted-foreground">
            A replay never re-sends an email the provider accepted, never creates a new enrollment and runs the version the enrollment is on. Unknown outcomes reuse the same idempotency key (provider de-duplication lasts {r?.idempotencyWindowHours ?? 23} h).
          </p>
          {candidates.length === 0 ? <p className="text-muted-foreground">Nothing to recover.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left">
                <thead className="text-[11px] text-muted-foreground"><tr><th className="py-1 font-semibold">Item</th><th className="font-semibold">Status</th><th className="font-semibold">Detail</th><th /></tr></thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={`${c.scope}-${c.targetId}`} className={`border-t border-border ${selected?.targetId === c.targetId ? "bg-muted" : ""}`}>
                      <td className="py-1">{c.label}</td>
                      <td><EmBadge value={c.status} /></td>
                      <td className="text-muted-foreground">{c.detail}</td>
                      <td><button type="button" className={emBtnOutline} onClick={() => { setSelected(c); setPlan(null); setExecuted(null); setAcknowledged(false); setMsg(null); }}>Select</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {truncated && <p role="status" className="text-amber-700">More items exist than are shown; resolve these first and reload.</p>}

          {selected && (
            <form className="flex flex-col gap-2 rounded-md border border-border p-3" onSubmit={(e) => { e.preventDefault(); dryRun.mutate(selected); }}>
              <p className="font-semibold">{selected.label} <span className="font-normal text-muted-foreground">({human(selected.scope)})</span></p>
              <EmField label="Reason (audited)">
                <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={emInput} minLength={5} maxLength={500} required />
              </EmField>
              <div><button type="submit" className={emBtnOutline} disabled={reason.trim().length < 5 || dryRun.isPending}>{dryRun.isPending ? "Planning…" : "Dry run"}</button></div>
            </form>
          )}

          {p && (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="au-replay-plan">
              {p.refusal ? (
                <p role="alert" className="text-red-600"><strong>Refused: {human(p.refusal.code)}.</strong> {p.refusal.message}</p>
              ) : (
                <>
                  <p className="font-semibold">Plan ({human(p.action)}) · version v{p.version} · step {p.stepId}</p>
                  <ol className="list-decimal pl-5">{p.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                  {p.checks && <p className="text-muted-foreground">Consent {p.checks.consent.status.toLowerCase()} · {p.checks.suppressed ? "suppressed" : "not suppressed"} · contact {p.checks.contactStatus.toLowerCase()}</p>}
                  {p.requiresAcknowledgement && (
                    <label className="flex items-start gap-2 text-amber-800">
                      <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                      <span>I understand the earlier attempt may have reached the provider. The replay reuses idempotency key <span className="font-mono">{p.idempotency?.key}</span>; the provider de-duplicates until {p.idempotency?.providerDeduplicatesUntil ? formatFullDate(p.idempotency.providerDeduplicatesUntil) : "the window ends"}.</span>
                    </label>
                  )}
                  {org.canApprove ? (
                    <div><button type="button" className={emBtn} disabled={!canExecute || execute.isPending} onClick={() => setStepUpOpen(true)}>{execute.isPending ? "Executing…" : "Execute (requires 2FA code)"}</button></div>
                  ) : (
                    <p className="text-muted-foreground">A brand reviewer must execute this replay.</p>
                  )}
                </>
              )}
            </div>
          )}
          {executed?.outcome && (
            <p role="status" data-testid="au-replay-result" className="text-emerald-700">
              Executed {human(executed.outcome.action)} · job {executed.outcome.jobId.slice(0, 8)}{executed.outcome.idempotencyKeyReused ? " · same idempotency key" : ""}
            </p>
          )}
          <EmMessage message={msg?.text ?? null} tone={msg?.tone} />

          <details>
            <summary className="cursor-pointer font-semibold">Replay history</summary>
            <ul className="mt-2 flex flex-col gap-1" aria-label="Replay history">
              {(historyQ.data?.items ?? []).length === 0 && <li className="text-muted-foreground">No replays yet.</li>}
              {(historyQ.data?.items ?? []).map((row) => (
                <li key={row.id}>
                  {formatFullDate(row.createdAt)} · {human(row.mode)} <EmBadge value={row.status} /> · {human(row.scope)} · {row.reason}
                  {row.result?.plan?.refusal ? <span className="text-muted-foreground"> · {human(row.result.plan.refusal.code)}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        </div>
      </PermissionBoundary>
      {stepUpOpen && selected && (
        <StepUpDialog
          purpose="MARKETING_AUTOMATION_REPLAY"
          title="Confirm this replay"
          onCancel={() => setStepUpOpen(false)}
          onVerified={async (id) => {
            setStepUpOpen(false);
            await execute.mutateAsync(id).catch(() => undefined);
          }}
        />
      )}
    </EmCard>
  );
}
