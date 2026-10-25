"use client";

// M10: rollout controls for mail administrators: emergency stops, readiness
// gates, pilot cohorts (onboarding/offboarding) and rollout rules. Widening
// exposure (ALLOW rules, revoking DENY rules, releasing a stop) needs an MFA
// step-up; narrowing it (DENY, activating a stop) is immediate.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import StaffPicker from "@/components/mail/StaffPicker";
import StepUpDialog from "@/components/marketing/email-marketing/StepUpDialog";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import {
  activateEmergencyStop,
  addCohortMember,
  createCohort,
  createRolloutRule,
  releaseEmergencyStop,
  removeCohortMember,
  revokeRolloutRule,
  rolloutOverview,
  rolloutReadiness,
} from "@/lib/mail-rollout.service";
import type { RolloutOverview, RolloutRule } from "@/types/mail-rollout.types";
import type { StaffDirectoryEntry } from "@/types/mail.types";

const card = "rounded-lg border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";
const ghost = "rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50";
const danger = "rounded-md bg-red-700 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50";
const KEY = ["mail", "rollout"] as const;

const STATUS_TONE: Record<string, string> = {
  PASS: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  FAIL: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  MANUAL: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
};

type PendingStepUp = { title: string; purpose: string; run: (stepUpId: string) => Promise<unknown> };

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

function Stops({ data, requestStepUp }: { data: RolloutOverview; requestStepUp: (p: PendingStepUp) => void }) {
  const refresh = useRefresh();
  const [scope, setScope] = useState("ALL");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const activate = useMutation({
    mutationFn: () => activateEmergencyStop({ scope, reason: reason.trim() }),
    onSuccess: () => { setMsg("Emergency stop active. Queued mail is held, not sent."); setReason(""); refresh(); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const active = data.emergencyStops.filter((stop) => !stop.releasedAt);
  return (
    <section className={card} aria-labelledby="stops-h">
      <h2 id="stops-h" className="mb-2 text-[13px] font-semibold">Emergency stop</h2>
      {(data.environmentStops.all || data.environmentStops.marketing) && (
        <p role="alert" className="mb-2 rounded bg-red-100 px-2 py-1 text-[12px] text-red-900 dark:bg-red-900/40 dark:text-red-100">
          An environment-level stop ({data.environmentStops.all ? "all mail" : "marketing"}) is set in server configuration and can only be released by a redeploy.
        </p>
      )}
      {active.length === 0 ? <p className="text-[12px] text-muted-foreground">No stop is active.</p> : (
        <ul className="mb-2 flex flex-col gap-2 text-[12px]">
          {active.map((stop) => (
            <li key={stop.id} role="alert" className="flex flex-wrap items-center gap-2 rounded border border-red-600 p-2">
              <span className="font-semibold">{stop.scope === "ALL" ? "All sending stopped" : stop.scope === "MARKETING" ? "Marketing stopped" : `Brand stopped (${stop.organizationId})`}</span>
              <span className="text-muted-foreground">since {formatFullDate(stop.activatedAt)}: {stop.reason}</span>
              <button type="button" className={`${ghost} ml-auto`} onClick={() => requestStepUp({ title: "Release emergency stop", purpose: "MAIL_EMERGENCY_STOP_RELEASE", run: (id) => releaseEmergencyStop(stop.id, id) })}>Release…</button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); activate.mutate(); }}>
        <label className="text-[11px] text-muted-foreground">Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)} className={input}>
            <option value="ALL">All sending</option>
            <option value="MARKETING">Marketing only</option>
          </select>
        </label>
        <label className="min-w-[200px] flex-1 text-[11px] text-muted-foreground">Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={input} required minLength={5} />
        </label>
        <button type="submit" className={danger} disabled={reason.trim().length < 5 || activate.isPending}>Stop now</button>
      </form>
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}

function ReadinessView() {
  const readiness = useQuery({ queryKey: [...KEY, "readiness"], queryFn: rolloutReadiness, retry: false });
  return (
    <section className={card} aria-labelledby="ready-h">
      <h2 id="ready-h" className="mb-2 text-[13px] font-semibold">Rollout readiness</h2>
      <PermissionBoundary isLoading={readiness.isLoading} error={readiness.error} compact>
        <div className="flex flex-col gap-3">
          {(readiness.data?.stages ?? []).map((stage) => (
            <details key={stage.id} className="rounded border border-border p-2" open={!stage.automatedReady}>
              <summary className="cursor-pointer text-[12px] font-semibold">
                {stage.label}: {stage.automatedReady ? "automated gates pass" : "blocked"}{stage.manualPending ? `, ${stage.manualPending} sign-off(s) to record` : ""}
              </summary>
              <ul className="mt-2 flex flex-col gap-1 text-[12px]">
                {stage.gates.map((gate) => (
                  <li key={gate.id} className="flex items-start gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_TONE[gate.status]}`}>{gate.status}</span>
                    <span>{gate.label}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </PermissionBoundary>
    </section>
  );
}

function Cohorts({ data }: { data: RolloutOverview }) {
  const refresh = useRefresh();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [cohortId, setCohortId] = useState("");
  const [staff, setStaff] = useState<StaffDirectoryEntry | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const onError = (e: unknown) => setMsg(classifyMailError(e).message);
  const create = useMutation({ mutationFn: () => createCohort({ key: key.trim(), name: name.trim() }), onSuccess: () => { setKey(""); setName(""); setMsg("Cohort created."); refresh(); }, onError });
  const add = useMutation({ mutationFn: () => addCohortMember(cohortId, staff!.id), onSuccess: () => { setStaff(null); setMsg("Staff member onboarded to the pilot."); refresh(); }, onError });
  const remove = useMutation({ mutationFn: (v: { cohortId: string; adminUserId: string }) => removeCohortMember(v.cohortId, v.adminUserId), onSuccess: () => { setMsg("Staff member offboarded. Access ends on their next send."); refresh(); }, onError });
  return (
    <section className={card} aria-labelledby="cohorts-h">
      <h2 id="cohorts-h" className="mb-2 text-[13px] font-semibold">Pilot cohorts</h2>
      <ul className="flex flex-col gap-2 text-[12px]">
        {data.cohorts.length === 0 && <li className="text-muted-foreground">No cohorts yet.</li>}
        {data.cohorts.map((cohort) => (
          <li key={cohort.id} className="rounded border border-border p-2">
            <p className="font-semibold">{cohort.name} <span className="font-normal text-muted-foreground">({cohort.key}, {cohort.members.length} member{cohort.members.length === 1 ? "" : "s"})</span></p>
            <ul>
              {cohort.members.map((member) => (
                <li key={member.adminUserId} className="flex items-center gap-2 border-t border-border py-1">
                  <span className="flex-1 truncate">{member.adminUserId}</span>
                  <span className="text-muted-foreground">since {formatFullDate(member.addedAt)}</span>
                  <button type="button" className={ghost} onClick={() => remove.mutate({ cohortId: cohort.id, adminUserId: member.adminUserId })} aria-label={`Offboard ${member.adminUserId} from ${cohort.key}`}>Offboard</button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <form className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label className="text-[11px] text-muted-foreground">Cohort key
          <input value={key} onChange={(e) => setKey(e.target.value)} className={input} placeholder="pilot-wave-1" />
        </label>
        <label className="text-[11px] text-muted-foreground">Cohort name
          <input value={name} onChange={(e) => setName(e.target.value)} className={input} />
        </label>
        <button type="submit" className={`${btn} self-end justify-self-start`} disabled={!key.trim() || !name.trim()}>Create cohort</button>
      </form>
      {data.cohorts.length > 0 && (
        <form className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); if (cohortId && staff) add.mutate(); }}>
          <label className="text-[11px] text-muted-foreground">Onboard to cohort
            <select value={cohortId} onChange={(e) => setCohortId(e.target.value)} className={input}>
              <option value="">Select…</option>
              {data.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}
            </select>
          </label>
          <div className="text-[11px] text-muted-foreground">Staff member<StaffPicker value={staff} onChange={setStaff} onForbidden={() => setMsg("You cannot search the staff directory.")} /></div>
          <button type="submit" className={`${btn} self-end justify-self-start`} disabled={!cohortId || !staff || add.isPending}>Onboard</button>
        </form>
      )}
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}

function scopeLabel(rule: RolloutRule, data: RolloutOverview) {
  if (rule.scopeType === "ENVIRONMENT") return `all of ${rule.environment}`;
  if (rule.scopeType === "COHORT") return `cohort ${data.cohorts.find((c) => c.id === rule.scopeId)?.key ?? rule.scopeId}`;
  return `${rule.scopeType.toLowerCase()} ${rule.scopeId}`;
}

function Rules({ data, requestStepUp }: { data: RolloutOverview; requestStepUp: (p: PendingStepUp) => void }) {
  const refresh = useRefresh();
  const [form, setForm] = useState({ capability: "STAFF_MAIL", scopeType: "COHORT", scopeId: "", effect: "ALLOW", reason: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const active = data.rules.filter((rule) => !rule.revokedAt);
  const worker = form.capability.startsWith("WORKER_");
  const scopeType = worker ? "ENVIRONMENT" : form.scopeType;
  const payload = { capability: form.capability, scopeType, scopeId: scopeType === "ENVIRONMENT" ? null : form.scopeId.trim(), effect: form.effect, reason: form.reason.trim() };
  const submit = async () => {
    setMsg(null);
    if (form.effect === "ALLOW") {
      requestStepUp({ title: `Allow ${form.capability}`, purpose: "MAIL_ROLLOUT_CHANGE", run: (stepUpId) => createRolloutRule({ ...payload, stepUpId }) });
      return;
    }
    try {
      await createRolloutRule(payload);
      setMsg("Rule created.");
      refresh();
    } catch (e) {
      setMsg(classifyMailError(e).message);
    }
  };
  const revoke = async (rule: RolloutRule) => {
    if (rule.effect === "DENY") {
      requestStepUp({ title: "Revoke DENY rule (widens access)", purpose: "MAIL_ROLLOUT_CHANGE", run: (stepUpId) => revokeRolloutRule(rule.id, stepUpId) });
      return;
    }
    try {
      await revokeRolloutRule(rule.id);
      refresh();
    } catch (e) {
      setMsg(classifyMailError(e).message);
    }
  };
  return (
    <section className={card} aria-labelledby="rules-h">
      <h2 id="rules-h" className="mb-1 text-[13px] font-semibold">Rollout rules ({data.environment})</h2>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {data.enforced ? "Enforcement is on: a capability is available only where an ALLOW rule matches and no DENY rule does." : "Enforcement is off in this environment: rules are recorded but only emergency stops take effect."}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <caption className="sr-only">Active rollout rules</caption>
          <thead><tr className="text-muted-foreground"><th scope="col" className="py-1">Effect</th><th scope="col">Capability</th><th scope="col">Scope</th><th scope="col">Reason</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {active.length === 0 && <tr><td colSpan={5} className="py-1 text-muted-foreground">No active rules.</td></tr>}
            {active.map((rule) => (
              <tr key={rule.id} className="border-t border-border">
                <td className="py-1 font-semibold">{rule.effect}</td>
                <td>{rule.capability}</td>
                <td>{scopeLabel(rule, data)}</td>
                <td className="max-w-[200px] truncate">{rule.reason}</td>
                <td><button type="button" className={ghost} onClick={() => revoke(rule)} aria-label={`Revoke ${rule.effect} ${rule.capability}`}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="text-[11px] text-muted-foreground">Effect
          <select value={form.effect} onChange={(e) => setForm({ ...form, effect: e.target.value })} className={input}>
            <option value="ALLOW">Allow</option>
            <option value="DENY">Deny</option>
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">Capability
          <select value={form.capability} onChange={(e) => setForm({ ...form, capability: e.target.value })} className={input}>
            {data.capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">Scope
          <select value={scopeType} disabled={worker} onChange={(e) => setForm({ ...form, scopeType: e.target.value })} className={input}>
            {data.scopeTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        {scopeType === "COHORT" ? (
          <label className="text-[11px] text-muted-foreground">Cohort
            <select value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} className={input}>
              <option value="">Select…</option>
              {data.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.key}</option>)}
            </select>
          </label>
        ) : (
          <label className="text-[11px] text-muted-foreground">Scope ID
            <input value={form.scopeId} disabled={scopeType === "ENVIRONMENT"} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} className={input} placeholder={scopeType === "ENVIRONMENT" ? "n/a" : "UUID"} />
          </label>
        )}
        <label className="col-span-2 text-[11px] text-muted-foreground sm:col-span-1">Reason
          <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={input} />
        </label>
        <button type="submit" className={`${btn} col-span-2 justify-self-start`} disabled={form.reason.trim().length < 5 || (scopeType !== "ENVIRONMENT" && !form.scopeId.trim())}>
          {form.effect === "ALLOW" ? "Allow… (needs 2FA)" : "Deny now"}
        </button>
      </form>
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}

export default function RolloutAdmin() {
  const refresh = useRefresh();
  const overview = useQuery({ queryKey: [...KEY, "overview"], queryFn: rolloutOverview, retry: false });
  const [pending, setPending] = useState<PendingStepUp | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <PermissionBoundary isLoading={overview.isLoading} error={overview.error} retry={() => overview.refetch()} forbiddenMessage="Rollout controls are available to mail administrators only.">
        {overview.data && (
          <>
            <Stops data={overview.data} requestStepUp={setPending} />
            <ReadinessView />
            <Cohorts data={overview.data} />
            <Rules data={overview.data} requestStepUp={setPending} />
          </>
        )}
      </PermissionBoundary>
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
    </div>
  );
}
