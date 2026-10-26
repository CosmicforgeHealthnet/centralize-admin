"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { classifyMailError } from "@/lib/mail.service";
import { fetchContacts, testAutomationVersion } from "@/lib/mail-marketing.service";
import type { Automation, AutomationTestInput, AutomationTestPathEntry, AutomationTestResult, AutomationVersion, MarketingOrganization } from "@/types/mail-marketing.types";
import { EmBadge, EmCard, EmField, EmMessage, emBtn, emInput } from "./em-ui";

const fmt = (iso?: string | null) => (iso ? iso.replace("T", " ").replace(/:00\.000Z$/, "Z").replace(/\.000Z$/, "Z") : "–");

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden="true" className={ok ? "text-emerald-600" : "text-red-600"}>{ok ? "✓" : "✕"}</span>
      <span>
        <span className="font-semibold">{label}</span>
        {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
      </span>
    </li>
  );
}

function PathStep({ entry }: { entry: AutomationTestPathEntry }) {
  return (
    <li className="rounded-md border border-border p-2" data-testid={`au-test-step-${entry.stepId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold">{entry.stepId}</span>
        <span className="text-muted-foreground">{entry.type.replace("_", " ")}</span>
        {entry.action && <EmBadge value={entry.action === "WOULD_SEND" ? "ACTIVE" : "FAILED"} />}
        {entry.action && <span className="text-muted-foreground">{entry.action.replace(/_/g, " ").toLowerCase()}{entry.reason ? `: ${entry.reason}` : ""}</span>}
      </div>
      {entry.type === "delay" && (
        <p className="mt-1">
          Runs at <strong>{fmt(entry.runAt)}</strong> UTC = <strong>{entry.localRunAt ?? "–"}</strong>
          {entry.timeZone ? ` (${entry.timeZone}${entry.timeZoneSource ? `, ${entry.timeZoneSource.toLowerCase().replace(/_/g, " ")}` : ""})` : ""}
          {entry.timeZoneFallback ? <span className="text-amber-700"> · fallback: {entry.fallbackReason?.toLowerCase().replace(/_/g, " ")}</span> : null}
          {entry.shiftedMinutes ? <span className="text-amber-700"> · shifted forward {entry.shiftedMinutes} min (daylight-saving gap)</span> : null}
          {entry.ambiguous ? <span className="text-amber-700"> · ambiguous local time: first occurrence used</span> : null}
          {entry.windowDeferred ? <span className="text-muted-foreground"> · moved into the delivery window</span> : null}
        </p>
      )}
      {entry.type === "condition" && (
        <p className="mt-1">
          <span className="font-mono">{entry.condition?.field} {entry.condition?.op} {JSON.stringify(entry.condition?.value ?? null)}</span> → <strong>{String(entry.result)}</strong> (takes “{entry.branch}” → {entry.next ?? "end"})
          {entry.simulatedEngagement ? <span className="text-muted-foreground"> · engagement simulated</span> : null}
        </p>
      )}
      {entry.type === "send_email" && entry.action === "WOULD_SEND" && (
        <div className="mt-1 flex flex-col gap-1">
          <p>Sends at <strong>{fmt(entry.sendAt)}</strong> UTC = <strong>{entry.localSendAt}</strong></p>
          {(entry.holds ?? []).map((hold) => (
            <p key={hold.reason} className="text-amber-700">Held by {hold.reason.toLowerCase().replace(/_/g, " ")} until {fmt(hold.until)}{hold.localUntil ? ` (${hold.localUntil})` : ""}</p>
          ))}
          {entry.template && (
            <p className="text-muted-foreground">
              Template {entry.template.templateName} v{entry.template.version} · classification {entry.template.classificationAvailable ? (entry.template.classification ?? "unknown") : "not available yet"}
            </p>
          )}
          {entry.personalization?.subject && <p>Subject: <strong>{entry.personalization.subject}</strong></p>}
          {entry.personalization?.error && <p className="text-red-600">Template does not render: {entry.personalization.error}</p>}
          {!!entry.personalization?.missingVariables?.length && <p className="text-amber-700">Missing for this contact: {entry.personalization.missingVariables.join(", ")} (rendered empty)</p>}
          {entry.personalization?.text && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Plain-text preview</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">{entry.personalization.text}</pre>
            </details>
          )}
          {(entry.warnings ?? []).map((warning) => <p key={warning} className="text-amber-700">{warning}</p>)}
        </div>
      )}
    </li>
  );
}

/** Read-only test of a version: nothing is sent, enrolled or queued. */
export default function AutomationTestPanel({ org, automation, versions }: { org: MarketingOrganization; automation: Automation; versions: AutomationVersion[] }) {
  const [versionId, setVersionId] = useState<string>(versions.find((v) => v.status === "PUBLISHED")?.id ?? versions[0]?.id ?? "");
  const [kind, setKind] = useState<"real" | "synthetic">("synthetic");
  const [q, setQ] = useState("");
  const [contactId, setContactId] = useState("");
  const [synthetic, setSynthetic] = useState({ email: "test.reader@example.com", firstName: "", lastName: "", timezone: "", consentStatus: "GRANTED" as NonNullable<AutomationTestInput["contact"]>["consentStatus"] });
  const [now, setNow] = useState("");
  const [eventPayload, setEventPayload] = useState("{}");
  const [eventId, setEventId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const contactsQ = useQuery({ queryKey: ["mail", "marketing", org.id, "contacts", "au-test", q], queryFn: () => fetchContacts(org.id, { q: q || undefined }), enabled: kind === "real", retry: false });
  const run = useMutation({
    mutationFn: () => {
      let payload: Record<string, unknown> = {};
      try {
        payload = eventPayload.trim() ? JSON.parse(eventPayload) : {};
      } catch {
        throw new Error("Event payload must be JSON.");
      }
      const body: AutomationTestInput = {
        ...(kind === "real" ? { contactId } : { contact: { email: synthetic.email, firstName: synthetic.firstName || undefined, lastName: synthetic.lastName || undefined, timezone: synthetic.timezone || undefined, consentStatus: synthetic.consentStatus } }),
        ...(now ? { now: new Date(now).toISOString() } : {}),
        event: { payload, ...(eventId ? { eventId } : {}) },
      };
      return testAutomationVersion(org.id, automation.id, versionId, body);
    },
    onMutate: () => setMsg(null),
    onError: (err) => setMsg(err instanceof Error && err.message === "Event payload must be JSON." ? err.message : classifyMailError(err).message),
  });
  const result: AutomationTestResult | undefined = run.data;

  return (
    <EmCard title="Test (nothing is sent)" id="au-test">
      <form className="flex flex-col gap-3 text-[12px]" onSubmit={(e) => { e.preventDefault(); if (versionId) run.mutate(); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <EmField label="Version">
            <select value={versionId} onChange={(e) => setVersionId(e.target.value)} className={emInput}>
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} ({v.status.toLowerCase().replace("_", " ")})</option>)}
            </select>
          </EmField>
          <EmField label="Contact">
            <select value={kind} onChange={(e) => setKind(e.target.value as "real" | "synthetic")} className={emInput}>
              <option value="synthetic">Synthetic contact</option>
              <option value="real">Existing contact of this brand</option>
            </select>
          </EmField>
          <EmField label="Simulated now (your local time)" hint="Empty = now">
            <input type="datetime-local" value={now} onChange={(e) => setNow(e.target.value)} className={emInput} />
          </EmField>
        </div>
        {kind === "real" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <EmField label="Search contacts">
              <input value={q} onChange={(e) => setQ(e.target.value)} className={emInput} placeholder="email or name" />
            </EmField>
            <EmField label="Contact">
              <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={emInput} required>
                <option value="">Select…</option>
                {(contactsQ.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.email}</option>)}
              </select>
            </EmField>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <EmField label="Email"><input type="email" value={synthetic.email} onChange={(e) => setSynthetic({ ...synthetic, email: e.target.value })} className={emInput} required /></EmField>
            <EmField label="First name"><input value={synthetic.firstName} onChange={(e) => setSynthetic({ ...synthetic, firstName: e.target.value })} className={emInput} /></EmField>
            <EmField label="Last name"><input value={synthetic.lastName} onChange={(e) => setSynthetic({ ...synthetic, lastName: e.target.value })} className={emInput} /></EmField>
            <EmField label="Time zone (IANA)" hint="Empty = brand default"><input value={synthetic.timezone} onChange={(e) => setSynthetic({ ...synthetic, timezone: e.target.value })} className={emInput} placeholder="Europe/London" /></EmField>
            <EmField label="Consent">
              <select value={synthetic.consentStatus} onChange={(e) => setSynthetic({ ...synthetic, consentStatus: e.target.value as typeof synthetic.consentStatus })} className={emInput}>
                {["GRANTED", "WITHDRAWN", "PENDING_CONFIRMATION", "NONE"].map((s) => <option key={s} value={s}>{s.toLowerCase().replace("_", " ")}</option>)}
              </select>
            </EmField>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <EmField label="Simulated trigger payload (JSON)" hint={automation.triggerType === "PRODUCT_EVENT" ? "Only the approved fields are kept, like a real event." : "Used by event.* conditions."}>
            <textarea rows={2} value={eventPayload} onChange={(e) => setEventPayload(e.target.value)} className={`${emInput} font-mono`} />
          </EmField>
          {automation.triggerType === "PRODUCT_EVENT" && (
            <EmField label="Event id (optional)" hint="Checks duplicate delivery">
              <input value={eventId} onChange={(e) => setEventId(e.target.value)} className={emInput} />
            </EmField>
          )}
        </div>
        <div><button type="submit" className={emBtn} disabled={!versionId || run.isPending || (kind === "real" && !contactId)}>{run.isPending ? "Testing…" : "Run test"}</button></div>
        <EmMessage message={msg} tone="error" />
      </form>

      {result && (
        <div className="mt-4 flex flex-col gap-3 text-[12px]" aria-live="polite" data-testid="au-test-result">
          <p role="status" className="font-semibold">{result.expected.summary} <span className="font-normal text-muted-foreground">Test mode: no email, enrollment or job was created.</span></p>
          {!result.validation.ok && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-red-700">
              Definition problems: {result.validation.errors.map((e) => `${e.field}${e.reason ? ` (${e.reason})` : ""}`).join("; ")}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ul className="flex flex-col gap-1" aria-label="Trigger and enrollment">
              <Check ok={result.trigger.matches} label="Trigger matches" detail={result.trigger.reason?.toLowerCase().replace(/_/g, " ") ?? (result.trigger.nextOccurrence ? `next occurrence ${fmt(result.trigger.nextOccurrence)}` : null)} />
              {result.trigger.duplicate?.eventIdSeen && <Check ok={false} label="Duplicate event" detail={result.trigger.duplicate.note} />}
              {!!result.trigger.simulatedEvent?.droppedFields?.length && <Check ok label="Payload minimised" detail={`dropped ${result.trigger.simulatedEvent.droppedFields.join(", ")}`} />}
              <Check ok={result.eligibility.automationStatus === "ACTIVE"} label={`Automation ${result.eligibility.automationStatus.toLowerCase()}`} />
              <Check ok={result.eligibility.enrollmentCap.ok} label="Enrollment limit" detail={`${result.eligibility.enrollmentCap.priorEnrollments}/${result.eligibility.enrollmentCap.limit}`} />
              <Check ok={result.eligibility.maxActiveEnrollments.ok} label="Active enrollment cap" detail={`${result.eligibility.maxActiveEnrollments.active}/${result.eligibility.maxActiveEnrollments.limit}`} />
              <Check ok={result.eligibility.wouldEnroll} label="Would enroll" detail={result.eligibility.enrollmentBlockers.join(", ").toLowerCase().replace(/_/g, " ") || null} />
            </ul>
            <ul className="flex flex-col gap-1" aria-label="Consent and sending checks">
              <Check ok={result.eligibility.consent.ok} label={`Consent (${result.eligibility.consent.topic})`} detail={`${result.eligibility.consent.status.toLowerCase()}${result.eligibility.consent.simulated ? ", simulated" : ""}`} />
              <Check ok={!result.eligibility.suppression.suppressed} label="Not suppressed" detail={result.eligibility.suppression.reason} />
              <Check ok={result.eligibility.contactStatus === "ACTIVE"} label={`Contact ${result.eligibility.contactStatus.toLowerCase()}`} />
              <Check ok label="Frequency cap" detail={`${result.eligibility.frequencyCap.hours} h${result.eligibility.frequencyCap.lastMarketingSendAt ? `, last send ${fmt(result.eligibility.frequencyCap.lastMarketingSendAt)}` : ""}`} />
              <Check ok={!result.contact.timeZoneFallback} label={`Time zone ${result.contact.timeZone}`} detail={result.contact.timeZoneFallback ? `fallback (${result.contact.fallbackReason?.toLowerCase().replace(/_/g, " ")})` : "from the contact"} />
            </ul>
          </div>
          <ol className="flex flex-col gap-2" aria-label="Expected execution path">
            {result.path.map((entry) => <PathStep key={`${entry.sequence}-${entry.stepId}`} entry={entry} />)}
          </ol>
        </div>
      )}
    </EmCard>
  );
}
