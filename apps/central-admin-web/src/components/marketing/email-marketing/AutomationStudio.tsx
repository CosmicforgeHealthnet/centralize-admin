"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import {
  activateAutomation,
  approveAutomationVersion,
  archiveAutomation,
  createAutomation,
  fetchApprovedProductEvents,
  fetchAudiences,
  fetchAutomation,
  fetchAutomationEnrollments,
  fetchAutomations,
  fetchSenderIdentities,
  fetchTemplate,
  fetchTemplates,
  pauseAutomation,
  rejectAutomationVersion,
  saveAutomationDraft,
  submitAutomationVersion,
} from "@/lib/mail-marketing.service";
import { useAuthStore } from "@/stores/auth.store";
import type { Automation, AutomationDefinition, AutomationStep, AutomationTrigger, MarketingOrganization } from "@/types/mail-marketing.types";
import StepUpDialog from "./StepUpDialog";
import { EmBadge, EmCard, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

const TRIGGERS: { value: AutomationTrigger; label: string; help: string }[] = [
  { value: "CONSENT_GRANTED", label: "Welcome (consent granted)", help: "Starts when a contact gives (and, for double opt-in, confirms) consent for the topic." },
  { value: "PRODUCT_EVENT", label: "Approved product event", help: "Starts on an approved, minimised product event. A product event is never consent; every send re-checks it." },
  { value: "SCHEDULE", label: "Recurring newsletter", help: "Enrolls the audience's consenting contacts on each scheduled occurrence. Missed occurrences are not backfilled." },
];
const STEP_TYPES: AutomationStep["type"][] = ["send_email", "delay", "condition", "exit"];
const FIELDS = ["first_name", "email_domain", "engagement.previous_send_delivered", "engagement.previous_send_opened"];
const OPS = ["equals", "not_equals", "contains", "exists", "gt", "lt"];

function emptyStep(type: AutomationStep["type"], id: string): AutomationStep {
  if (type === "send_email") return { id, type, templateVersionId: "", senderAddressId: "", subjectOverride: null, next: null };
  if (type === "delay") return { id, type, minutes: 1440, next: null };
  if (type === "condition") return { id, type, condition: { field: "first_name", op: "exists", value: null }, then: null, else: null };
  return { id, type: "exit" };
}

function StepEditor({ step, steps, onChange, onRemove, templates, senders, disabled }: {
  step: AutomationStep;
  steps: AutomationStep[];
  onChange: (step: AutomationStep) => void;
  onRemove: () => void;
  templates: { id: string; label: string }[];
  senders: { id: string; label: string }[];
  disabled: boolean;
}) {
  const targets = steps.filter((s) => s.id !== step.id);
  const nextSelect = (label: string, value: string | null, set: (v: string | null) => void) => (
    <EmField label={label}>
      <select value={value ?? ""} onChange={(e) => set(e.target.value || null)} className={emInput} disabled={disabled}>
        <option value="">End</option>
        {targets.map((t) => (
          <option key={t.id} value={t.id}>{t.id} ({t.type.replace("_", " ")})</option>
        ))}
      </select>
    </EmField>
  );
  return (
    <li className="rounded-md border border-border p-3">
      <div className="mb-2 flex items-center gap-2 text-[12px]">
        <span className="font-mono font-semibold">{step.id}</span>
        <select aria-label={`Step ${step.id} type`} value={step.type} onChange={(e) => onChange(emptyStep(e.target.value as AutomationStep["type"], step.id))} className="rounded border border-border bg-card px-1 py-0.5" disabled={disabled}>
          {STEP_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
        </select>
        {!disabled && (
          <button type="button" onClick={onRemove} className="ml-auto rounded p-1 hover:bg-muted" aria-label={`Remove step ${step.id}`}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {step.type === "send_email" && (
          <>
            <EmField label="Template version">
              <select value={step.templateVersionId} onChange={(e) => onChange({ ...step, templateVersionId: e.target.value })} className={emInput} disabled={disabled} required>
                <option value="">Select…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </EmField>
            <EmField label="Brand sender">
              <select value={step.senderAddressId} onChange={(e) => onChange({ ...step, senderAddressId: e.target.value })} className={emInput} disabled={disabled} required>
                <option value="">Select…</option>
                {senders.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </EmField>
            {nextSelect("Then", step.next, (next) => onChange({ ...step, next }))}
          </>
        )}
        {step.type === "delay" && (
          <>
            <EmField label="Wait (minutes)" hint="1 minute to 90 days">
              <input type="number" min={1} max={129600} value={step.minutes} onChange={(e) => onChange({ ...step, minutes: Number(e.target.value) })} className={emInput} disabled={disabled} />
            </EmField>
            {nextSelect("Then", step.next, (next) => onChange({ ...step, next }))}
          </>
        )}
        {step.type === "condition" && (
          <>
            <EmField label="If field">
              <select value={step.condition.field} onChange={(e) => onChange({ ...step, condition: { ...step.condition, field: e.target.value } })} className={emInput} disabled={disabled}>
                {FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </EmField>
            <EmField label="Operator">
              <select value={step.condition.op} onChange={(e) => onChange({ ...step, condition: { ...step.condition, op: e.target.value } })} className={emInput} disabled={disabled}>
                {OPS.map((o) => <option key={o} value={o}>{o.replace("_", " ")}</option>)}
              </select>
            </EmField>
            <EmField label="Value">
              <input value={typeof step.condition.value === "string" ? step.condition.value : ""} onChange={(e) => onChange({ ...step, condition: { ...step.condition, value: e.target.value } })} className={emInput} disabled={disabled || step.condition.op === "exists"} />
            </EmField>
            {nextSelect("When true", step.then, (then) => onChange({ ...step, then }))}
            {nextSelect("When false", step.else, (value) => onChange({ ...step, else: value }))}
          </>
        )}
        {step.type === "exit" && <p className="text-[12px] text-muted-foreground">Ends the enrollment.</p>}
      </div>
    </li>
  );
}

function AutomationDetail({ org, automationId }: { org: MarketingOrganization; automationId: string }) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const key = ["mail", "marketing", org.id, "automation", automationId];
  const automationQ = useQuery({ queryKey: key, queryFn: () => fetchAutomation(org.id, automationId), retry: false });
  const enrollmentsQ = useQuery({ queryKey: [...key, "enrollments"], queryFn: () => fetchAutomationEnrollments(org.id, automationId), retry: false });
  const templatesQ = useQuery({ queryKey: ["mail", "marketing", org.id, "templates"], queryFn: () => fetchTemplates(org.id), retry: false, gcTime: 300000 });
  const firstTemplate = templatesQ.data?.items?.[0]?.id;
  const templateDetails = useQuery({
    queryKey: ["mail", "marketing", org.id, "template-versions", (templatesQ.data?.items ?? []).map((t) => t.id).join(",")],
    queryFn: async () => Promise.all((templatesQ.data?.items ?? []).slice(0, 20).map((t) => fetchTemplate(org.id, t.id))),
    enabled: !!firstTemplate,
    retry: false,
  });
  const sendersQ = useQuery({ queryKey: ["mail", "marketing", org.id, "sender-identities"], queryFn: () => fetchSenderIdentities(org.id), retry: false, gcTime: 300000 });
  const audiencesQ = useQuery({ queryKey: ["mail", "marketing", org.id, "audiences"], queryFn: () => fetchAudiences(org.id), retry: false, gcTime: 300000 });
  const eventsQ = useQuery({ queryKey: ["mail", "marketing", org.id, "automation-events"], queryFn: () => fetchApprovedProductEvents(org.id), retry: false, gcTime: 300000 });

  const automation = automationQ.data;
  const versions = automation?.versions ?? [];
  const draft = versions.find((v) => v.status === "DRAFT");
  const pending = versions.find((v) => v.status === "PENDING_REVIEW");
  const base = draft ?? versions.find((v) => v.status === "PUBLISHED") ?? versions[0];
  const [definition, setDefinition] = useState<AutomationDefinition | null>(null);
  const [trigger, setTrigger] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const def: AutomationDefinition = definition ?? base?.definition ?? { topic: "newsletter", steps: [emptyStep("send_email", "s1")] };
  const trig: Record<string, unknown> = trigger ?? base?.triggerConfig ?? (automation?.triggerType === "SCHEDULE" ? { frequency: "weekly", weekday: 1, localTime: "09:00", timeZone: "UTC" } : automation?.triggerType === "PRODUCT_EVENT" ? { version: 1 } : {});
  const editable = org.canAuthor && automation?.status !== "ARCHIVED";
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const onErr = (err: unknown) => {
    const info = classifyMailError(err);
    const errors = (info.detail as { errors?: { field: string; reason?: string }[] } | undefined)?.errors;
    setMsg({ text: errors?.length ? `${info.message} ${errors.map((e) => `${e.field}${e.reason ? ` (${e.reason})` : ""}`).join("; ")}` : info.message, tone: "error" });
  };
  const ok = (text: string) => () => {
    setMsg({ text, tone: "info" });
    setDefinition(null);
    setTrigger(null);
    refresh();
  };
  const save = useMutation({ mutationFn: () => saveAutomationDraft(org.id, automationId, { definition: { ...def, entryStepId: def.steps[0]?.id }, triggerConfig: { ...trig, ...(automation?.triggerType === "CONSENT_GRANTED" ? { topic: def.topic } : {}) } }), onSuccess: ok("Draft saved."), onError: onErr });
  const submit = useMutation({ mutationFn: (versionId: string) => submitAutomationVersion(org.id, automationId, versionId), onSuccess: ok("Submitted for review."), onError: onErr });
  const approve = useMutation({ mutationFn: (stepUpId: string) => approveAutomationVersion(org.id, automationId, pending!.id, { stepUpId, definitionSha256: pending!.definitionSha256 }), onSuccess: ok("Version published. Running enrollments stay on the version they started with."), onError: onErr });
  const reject = useMutation({ mutationFn: () => rejectAutomationVersion(org.id, automationId, pending!.id, rejectComment.trim()), onSuccess: ok("Version rejected."), onError: onErr });
  const activate = useMutation({ mutationFn: () => activateAutomation(org.id, automationId), onSuccess: ok("Automation active."), onError: onErr });
  const pause = useMutation({ mutationFn: () => pauseAutomation(org.id, automationId), onSuccess: ok("Automation paused. Pending steps wait."), onError: onErr });
  const archive = useMutation({ mutationFn: () => archiveAutomation(org.id, automationId), onSuccess: ok("Automation archived; active enrollments were cancelled."), onError: onErr });

  const templateOptions = (templateDetails.data ?? []).flatMap((t) => (t.versions ?? []).map((v) => ({ id: v.id, label: `${t.name} · v${v.version}` })));
  const senderOptions = (sendersQ.data ?? []).map((s) => ({ id: s.addressId, label: s.address }));
  const setStep = (index: number, step: AutomationStep) => setDefinition({ ...def, steps: def.steps.map((s, i) => (i === index ? step : s)) });
  const nextId = () => {
    let n = def.steps.length + 1;
    while (def.steps.some((s) => s.id === `s${n}`)) n += 1;
    return `s${n}`;
  };

  return (
    <PermissionBoundary isLoading={automationQ.isLoading} error={automationQ.error}>
      {automation && (
        <div className="flex flex-col gap-4">
          <EmCard
            title={automation.name}
            id="au-detail"
            actions={
              <>
                <EmBadge value={automation.status} />
                {org.canApprove && automation.activeVersionId && ["DRAFT", "PAUSED"].includes(automation.status) && (
                  <button type="button" className={emBtn} onClick={() => activate.mutate()} disabled={!automation.executionEnabled || activate.isPending} title={automation.executionEnabled ? undefined : "Automation execution is not enabled in this environment"}>
                    {automation.status === "PAUSED" ? "Resume" : "Activate"}
                  </button>
                )}
                {(org.canAuthor || org.canApprove) && automation.status === "ACTIVE" && <button type="button" className={emBtnOutline} onClick={() => pause.mutate()}>Pause</button>}
                {(org.canAuthor || org.canApprove) && automation.status !== "ARCHIVED" && <button type="button" className={emBtnOutline} onClick={() => archive.mutate()}>Archive</button>}
              </>
            }
          >
            <p className="text-[12px] text-muted-foreground">{TRIGGERS.find((t) => t.value === automation.triggerType)?.help}</p>
            {!automation.executionEnabled && <p role="status" className="mt-1 text-[12px] text-amber-700">Automation execution is not enabled in this environment. Automations can be built and reviewed but will not send.</p>}
            <p className="mt-1 text-[12px] text-muted-foreground">Enrollments: {Object.entries(automation.enrollments ?? {}).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(" · ") || "none"}</p>
          </EmCard>

          <EmCard title={draft ? `Draft v${draft.version}` : "New draft"} id="au-builder">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <EmField label="Consent topic (required at every send)">
                  <input value={def.topic} onChange={(e) => setDefinition({ ...def, topic: e.target.value.toLowerCase() })} className={emInput} disabled={!editable} />
                </EmField>
                {automation.triggerType === "PRODUCT_EVENT" && (
                  <EmField label="Approved product event">
                    <select value={String(trig.eventType ?? "")} onChange={(e) => setTrigger({ ...trig, eventType: e.target.value, version: 1 })} className={emInput} disabled={!editable}>
                      <option value="">Select…</option>
                      {(eventsQ.data ?? []).map((ev) => <option key={ev.eventType} value={ev.eventType}>{ev.eventType}</option>)}
                    </select>
                  </EmField>
                )}
                {automation.triggerType === "SCHEDULE" && (
                  <>
                    <EmField label="Audience">
                      <select value={String(trig.audienceId ?? "")} onChange={(e) => setTrigger({ ...trig, audienceId: e.target.value })} className={emInput} disabled={!editable}>
                        <option value="">Select…</option>
                        {(audiencesQ.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </EmField>
                    <EmField label="Frequency">
                      <select value={String(trig.frequency ?? "weekly")} onChange={(e) => setTrigger({ ...trig, frequency: e.target.value })} className={emInput} disabled={!editable}>
                        {["daily", "weekly", "monthly"].map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </EmField>
                    {trig.frequency === "weekly" && (
                      <EmField label="Weekday">
                        <select value={String(trig.weekday ?? 1)} onChange={(e) => setTrigger({ ...trig, weekday: Number(e.target.value) })} className={emInput} disabled={!editable}>
                          {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={d} value={i}>{d}</option>)}
                        </select>
                      </EmField>
                    )}
                    {trig.frequency === "monthly" && (
                      <EmField label="Day of month (1-28)">
                        <input type="number" min={1} max={28} value={Number(trig.dayOfMonth ?? 1)} onChange={(e) => setTrigger({ ...trig, dayOfMonth: Number(e.target.value) })} className={emInput} disabled={!editable} />
                      </EmField>
                    )}
                    <EmField label="Local time">
                      <input type="time" value={String(trig.localTime ?? "09:00")} onChange={(e) => setTrigger({ ...trig, localTime: e.target.value })} className={emInput} disabled={!editable} />
                    </EmField>
                    <EmField label="Time zone">
                      <input value={String(trig.timeZone ?? "UTC")} onChange={(e) => setTrigger({ ...trig, timeZone: e.target.value })} className={emInput} disabled={!editable} />
                    </EmField>
                  </>
                )}
              </div>
              <ol className="flex flex-col gap-2" aria-label="Automation steps (the first step runs first)">
                {def.steps.map((step, index) => (
                  <StepEditor
                    key={`${step.id}-${index}`}
                    step={step}
                    steps={def.steps}
                    templates={templateOptions}
                    senders={senderOptions}
                    disabled={!editable}
                    onChange={(updated) => setStep(index, updated)}
                    onRemove={() => setDefinition({ ...def, steps: def.steps.filter((_, i) => i !== index) })}
                  />
                ))}
              </ol>
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={emBtnOutline} onClick={() => setDefinition({ ...def, steps: [...def.steps, emptyStep("delay", nextId())] })}>
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add step
                  </button>
                  <button type="submit" className={emBtn} disabled={save.isPending}>Save draft</button>
                  {draft && !definition && !trigger && <button type="button" className={emBtnOutline} onClick={() => submit.mutate(draft.id)} disabled={submit.isPending}>Submit for review</button>}
                </div>
              )}
            </form>
          </EmCard>

          {pending && (
            <EmCard title={`Review v${pending.version}`} id="au-review">
              {pending.createdBy === me?.id || pending.submittedBy === me?.id ? (
                <p className="text-[12px] text-muted-foreground">You authored this version; a different reviewer must approve it.</p>
              ) : org.canApprove ? (
                <div className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <p className="text-muted-foreground">Definition sha256 {pending.definitionSha256.slice(0, 16)}…</p>
                    <button type="button" className={emBtn} onClick={() => setStepUpOpen(true)} disabled={approve.isPending}>Publish (requires 2FA code)</button>
                  </div>
                  <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (rejectComment.trim()) reject.mutate(); }}>
                    <EmField label="Rejection reason">
                      <textarea rows={2} value={rejectComment} onChange={(e) => setRejectComment(e.target.value)} className={emInput} required />
                    </EmField>
                    <button type="submit" className={emBtnOutline} disabled={!rejectComment.trim()}>Reject</button>
                  </form>
                </div>
              ) : (
                <p className="text-[12px] text-muted-foreground">Awaiting review by a brand reviewer.</p>
              )}
            </EmCard>
          )}

          <EmCard title="Versions" id="au-versions">
            <ul className="flex flex-col gap-1 text-[12px]">
              {versions.length === 0 && <li className="text-muted-foreground">No versions yet.</li>}
              {versions.map((v) => (
                <li key={v.id}>
                  v{v.version} <EmBadge value={v.status} /> · {v.definition.steps.length} steps · {formatFullDate(v.createdAt)}{v.reviewComment ? ` · “${v.reviewComment}”` : ""}
                </li>
              ))}
            </ul>
          </EmCard>

          <EmCard title="Enrollments" id="au-enrollments">
            <PermissionBoundary isLoading={enrollmentsQ.isLoading} error={enrollmentsQ.error} compact>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-left text-[12px]">
                  <thead className="text-[11px] text-muted-foreground">
                    <tr><th className="py-1 font-semibold">Contact</th><th className="font-semibold">Version</th><th className="font-semibold">Status</th><th className="font-semibold">Step</th><th className="font-semibold">Next run / exit</th></tr>
                  </thead>
                  <tbody>
                    {(enrollmentsQ.data?.items ?? []).length === 0 && <tr><td colSpan={5} className="py-2 text-muted-foreground">No enrollments yet.</td></tr>}
                    {(enrollmentsQ.data?.items ?? []).map((e) => (
                      <tr key={e.id} className="border-t border-border">
                        <td className="py-1">{e.email}</td>
                        <td>v{e.version}</td>
                        <td><EmBadge value={e.status} /></td>
                        <td className="font-mono">{e.currentStepId ?? "–"}</td>
                        <td className="text-muted-foreground">{e.exitReason?.replace(/_/g, " ").toLowerCase() ?? (e.nextRunAt ? formatFullDate(e.nextRunAt) : "–")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </PermissionBoundary>
          </EmCard>
          <EmMessage message={msg?.text ?? null} tone={msg?.tone} />
          {stepUpOpen && pending && (
            <StepUpDialog
              purpose="MARKETING_AUTOMATION_PUBLISH"
              title="Confirm publishing this automation"
              onCancel={() => setStepUpOpen(false)}
              onVerified={async (id) => {
                await approve.mutateAsync(id);
                setStepUpOpen(false);
              }}
            />
          )}
        </div>
      )}
    </PermissionBoundary>
  );
}

export default function AutomationStudio({ org }: { org: MarketingOrganization }) {
  const qc = useQueryClient();
  const listQ = useQuery({ queryKey: ["mail", "marketing", org.id, "automations"], queryFn: () => fetchAutomations(org.id), retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<AutomationTrigger>("CONSENT_GRANTED");
  const [msg, setMsg] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => createAutomation(org.id, { name: name.trim(), triggerType }),
    onSuccess: (a: Automation) => {
      setName("");
      setSelected(a.id);
      qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "automations"] });
    },
    onError: (err) => setMsg(classifyMailError(err).message),
  });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <div className="flex flex-col gap-4">
        <EmCard title="Automations" id="au-list">
          <PermissionBoundary isLoading={listQ.isLoading} error={listQ.error} compact>
            <ul className="flex flex-col gap-1 text-[12px]">
              {(listQ.data ?? []).length === 0 && <li className="text-muted-foreground">No automations yet.</li>}
              {(listQ.data ?? []).map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setSelected(a.id)} aria-current={selected === a.id ? "true" : undefined} className={`flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-muted ${selected === a.id ? "bg-muted font-semibold" : ""}`}>
                    <span>{a.name}</span>
                    <EmBadge value={a.status} />
                  </button>
                </li>
              ))}
            </ul>
          </PermissionBoundary>
        </EmCard>
        {org.canAuthor && (
          <EmCard title="New automation" id="au-new">
            <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
              <EmField label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} className={emInput} maxLength={160} required />
              </EmField>
              <EmField label="Trigger">
                <select value={triggerType} onChange={(e) => setTriggerType(e.target.value as AutomationTrigger)} className={emInput}>
                  {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </EmField>
              <button type="submit" className={emBtn} disabled={!name.trim() || create.isPending}>Create</button>
              <EmMessage message={msg} tone="error" />
            </form>
          </EmCard>
        )}
      </div>
      <div>
        {selected ? <AutomationDetail key={selected} org={org} automationId={selected} /> : (
          <EmCard>
            <p className="text-[12px] text-muted-foreground">Select an automation, or create one. Every version is reviewed by a different brand reviewer with a 2FA code before it can run, and every email re-checks consent and suppression when it is sent.</p>
          </EmCard>
        )}
      </div>
    </div>
  );
}
