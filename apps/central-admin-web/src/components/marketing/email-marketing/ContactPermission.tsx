"use client";

// Contacts & consent: saving a contact is separate from marketing permission.
// Staff never choose a consent "source": the server records MANUAL for staff
// actions. Permission comes only from the contact's own email confirmation, or
// from previously documented consent that a second approver verifies.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatFullDate, isValidEmail } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import { createContact, decideConsentApproval, fetchConsentApprovals, fetchConsentOptions, recordConsent } from "@/lib/mail-marketing.service";
import type { AdminConsentMode, ConsentInput, ConsentOptions, MarketingOrganization, MarketingPermission } from "@/types/mail-marketing.types";
import { EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

type PermissionChoice = "NONE" | AdminConsentMode;

const CHOICES: { value: PermissionChoice; label: string; help: string }[] = [
  { value: "NONE", label: "Save contact only", help: "No marketing emails until permission is recorded." },
  { value: "REQUEST_CONFIRMATION", label: "Ask them to confirm by email", help: "Recommended. They get a confirmation link and can receive marketing after they confirm." },
  { value: "DOCUMENTED", label: "They already agreed (I have proof)", help: "A second approver checks your proof before it counts." },
];

export function useConsentOptions(orgId: string) {
  return useQuery({ queryKey: ["mail", "marketing", orgId, "consent-options"], queryFn: () => fetchConsentOptions(orgId), gcTime: 300000, retry: false });
}

/** Accurate, plain-language outcome of a permission request. */
export function permissionMessage(permission: MarketingPermission | undefined, extra: { emailQueued?: boolean; expiresAt?: string | null } = {}) {
  switch (permission) {
    case "PENDING_CONFIRMATION":
      return extra.emailQueued
        ? "Confirmation email queued. They can receive marketing only after they confirm."
        : "Waiting for the contact to confirm. Confirmation emails are not enabled here, so no email was sent.";
    case "PENDING_APPROVAL":
      return `Waiting for a second approver to check the proof${extra.expiresAt ? ` (by ${formatFullDate(extra.expiresAt)})` : ""}. No marketing emails until it is approved.`;
    case "GRANTED":
      return "Marketing permission is active.";
    default:
      return "Saved without marketing permission. They will not receive marketing emails.";
  }
}

function PermissionFields({ options, choice, setChoice, topic, setTopic, policyVersion, setPolicyVersion, proof, setProof, note, setNote, agreedOn, setAgreedOn, allowNone }: {
  options: ConsentOptions | undefined;
  choice: PermissionChoice; setChoice: (v: PermissionChoice) => void;
  topic: string; setTopic: (v: string) => void;
  policyVersion: string; setPolicyVersion: (v: string) => void;
  proof: string; setProof: (v: string) => void;
  note: string; setNote: (v: string) => void;
  agreedOn: string; setAgreedOn: (v: string) => void;
  allowNone: boolean;
}) {
  const noPolicy = options && options.policyVersions.length === 0;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 text-xs font-semibold text-foreground">Marketing permission</legend>
      {CHOICES.filter((c) => allowNone || c.value !== "NONE").map((c) => (
        <label key={c.value} className="flex items-start gap-2 rounded-lg border border-border p-2 text-[12px]">
          <input type="radio" name="permission" value={c.value} checked={choice === c.value} onChange={() => setChoice(c.value)} className="mt-0.5" />
          <span><span className="font-semibold text-foreground">{c.label}</span><span className="block text-muted-foreground">{c.help}</span></span>
        </label>
      ))}
      {choice !== "NONE" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <EmField label="Email list (topic)">
            <select value={topic} onChange={(e) => setTopic(e.target.value)} className={emInput} required>
              {(options?.topics ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </EmField>
          <EmField label="Privacy policy they agreed to">
            <select value={policyVersion} onChange={(e) => setPolicyVersion(e.target.value)} className={emInput} required disabled={noPolicy}>
              {(options?.policyVersions ?? []).map((v) => <option key={v} value={v}>{v}{v === options?.currentPolicyVersion ? " (current)" : ""}</option>)}
            </select>
          </EmField>
          {noPolicy && <p role="alert" className="text-[11px] text-red-600 sm:col-span-2">No privacy-policy version is configured for this brand. Ask a Mail administrator to configure one before recording permission.</p>}
        </div>
      )}
      {choice === "DOCUMENTED" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <EmField label="Where is the proof?" hint="For example a signed form number or a CRM record. The approver will check it.">
              <input value={proof} onChange={(e) => setProof(e.target.value)} className={emInput} required minLength={3} maxLength={500} />
            </EmField>
          </div>
          <EmField label="Date they agreed (optional)"><input type="date" value={agreedOn} onChange={(e) => setAgreedOn(e.target.value)} className={emInput} max={new Date().toISOString().slice(0, 10)} /></EmField>
          <EmField label="Notes for the approver (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} className={emInput} maxLength={1000} /></EmField>
        </div>
      )}
    </fieldset>
  );
}

function usePermissionState(options: ConsentOptions | undefined, initial: PermissionChoice) {
  const [choice, setChoice] = useState<PermissionChoice>(initial);
  const [topic, setTopic] = useState("");
  const [policyVersion, setPolicyVersion] = useState("");
  const [proof, setProof] = useState("");
  const [note, setNote] = useState("");
  const [agreedOn, setAgreedOn] = useState("");
  const effectiveTopic = topic || options?.topics[0] || "";
  const effectivePolicy = policyVersion || options?.currentPolicyVersion || options?.policyVersions[0] || "";
  const ready = choice === "NONE" || (Boolean(effectiveTopic && effectivePolicy) && (choice !== "DOCUMENTED" || proof.trim().length >= 3));
  const consent = (): ConsentInput | undefined => choice === "NONE" ? undefined : {
    mode: choice,
    topic: effectiveTopic,
    policyVersion: effectivePolicy,
    ...(choice === "DOCUMENTED" ? { evidence: { reference: proof.trim(), ...(note.trim() ? { note: note.trim() } : {}) }, ...(agreedOn ? { consentedAt: new Date(`${agreedOn}T12:00:00Z`).toISOString() } : {}) } : {}),
  };
  const fields = { choice, setChoice, topic: effectiveTopic, setTopic, policyVersion: effectivePolicy, setPolicyVersion, proof, setProof, note, setNote, agreedOn, setAgreedOn };
  return { fields, ready, consent, reset: () => { setProof(""); setNote(""); setAgreedOn(""); } };
}

export function AddContact({ org, onDone }: { org: MarketingOrganization; onDone: () => void }) {
  const options = useConsentOptions(org.id);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const permission = usePermissionState(options.data, "NONE");
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => createContact(org.id, { email: email.trim(), firstName: firstName.trim() || undefined, lastName: lastName.trim() || undefined, consent: permission.consent() }),
    onSuccess: (contact) => {
      setMsg({ text: `${contact.email}: ${permissionMessage(contact.marketingPermission, { emailQueued: contact.confirmationEmail?.queued === true, expiresAt: contact.consentApproval?.expiresAt })}`, tone: "info" });
      setEmail(""); setFirstName(""); setLastName(""); permission.reset();
      qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "consent-approvals"] });
      onDone();
    },
    onError: (e) => setMsg({ text: classifyMailError(e).message, tone: "error" }),
  });
  const valid = isValidEmail(email) && permission.ready;
  const label = { NONE: "Save contact", REQUEST_CONFIRMATION: "Save and send confirmation", DOCUMENTED: "Save and request approval" }[permission.fields.choice];
  return (
    <form className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3" onSubmit={(e) => { e.preventDefault(); if (valid) m.mutate(); }} aria-label="Add contact">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <EmField label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={emInput} required autoComplete="off" /></EmField>
        <EmField label="First name (optional)"><input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={emInput} /></EmField>
        <EmField label="Last name (optional)"><input value={lastName} onChange={(e) => setLastName(e.target.value)} className={emInput} /></EmField>
      </div>
      <PermissionFields options={options.data} allowNone {...permission.fields} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <button type="submit" className={emBtn} disabled={!valid || m.isPending}>{m.isPending ? "Saving…" : label}</button>
        <EmMessage message={msg?.text ?? null} tone={msg?.tone} />
      </div>
    </form>
  );
}

/** Ask for permission for an existing contact (e.g. one saved without it). */
export function RequestPermission({ org, contactId, email, onDone, onCancel }: { org: MarketingOrganization; contactId: string; email: string; onDone: (message: string) => void; onCancel: () => void }) {
  const options = useConsentOptions(org.id);
  const permission = usePermissionState(options.data, "REQUEST_CONFIRMATION");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => recordConsent(org.id, contactId, permission.consent() as ConsentInput),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "consent-approvals"] });
      onDone(`${email}: ${permissionMessage(result.status, { emailQueued: result.confirmationEmail?.queued === true, expiresAt: result.consentApproval?.expiresAt })}`);
    },
    onError: (e) => setError(classifyMailError(e).message),
  });
  return (
    <form className="mt-2 flex min-w-0 flex-col gap-2 rounded-md border border-border p-2" aria-label={`Request permission for ${email}`} onSubmit={(e) => { e.preventDefault(); if (permission.ready) m.mutate(); }}>
      <PermissionFields options={options.data} allowNone={false} {...permission.fields} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={emBtn} disabled={!permission.ready || m.isPending}>{permission.fields.choice === "DOCUMENTED" ? "Request approval" : "Send confirmation"}</button>
        <button type="button" className={emBtnOutline} onClick={onCancel}>Cancel</button>
        <EmMessage message={error} tone="error" />
      </div>
    </form>
  );
}

export function ConsentApprovals({ org }: { org: MarketingOrganization }) {
  const qc = useQueryClient();
  const key = ["mail", "marketing", org.id, "consent-approvals"];
  const q = useQuery({ queryKey: key, queryFn: () => fetchConsentApprovals(org.id), gcTime: 60000, retry: false });
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const decide = useMutation({
    mutationFn: ({ requestId, decision }: { requestId: string; decision: "APPROVE" | "REJECT" }) => decideConsentApproval(org.id, requestId, decision),
    onSuccess: (result) => {
      setMsg({ text: result.decision === "APPROVE" ? `Approved: ${result.topic} permission is now active.` : `Rejected: no permission was recorded.`, tone: "info" });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "contacts"] });
    },
    onError: (e) => setMsg({ text: classifyMailError(e).message, tone: "error" }),
  });
  const items = q.data ?? [];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted-foreground">
        Previously documented consent counts only after a second approver checks the proof. Approve only if you have seen it.
      </p>
      <EmMessage message={msg?.text ?? null} tone={msg?.tone} />
      {q.isError && <EmMessage message={classifyMailError(q.error).message} tone="error" />}
      {!q.isLoading && items.length === 0 && <p role="status" className="p-4 text-center text-[12px] text-muted-foreground">Nothing waiting for approval.</p>}
      <ul className="flex flex-col gap-2">
        {items.map((r) => (
          <li key={r.requestId} className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-3 text-[12px]">
            <span className="break-all font-semibold text-foreground">{r.email ?? "Contact"}</span>
            <span>List <strong>{r.topic}</strong> · policy {r.policyVersion}{r.consentedAt ? ` · agreed ${formatFullDate(r.consentedAt)}` : ""}</span>
            <span className="break-words">Proof: {r.evidenceReference}{r.evidenceNote ? ` — ${r.evidenceNote}` : ""}</span>
            <span className="text-muted-foreground">Requested {formatFullDate(r.requestedAt)} · expires {formatFullDate(r.expiresAt)}</span>
            {org.canApprove && !r.requestedByMe ? (
              <div className="mt-1 flex flex-wrap gap-2">
                <button type="button" className={emBtn} disabled={decide.isPending} onClick={() => window.confirm(`Approve ${r.topic} permission for ${r.email ?? "this contact"}? Only approve if you have checked the proof.`) && decide.mutate({ requestId: r.requestId, decision: "APPROVE" })}>Approve</button>
                <button type="button" className={emBtnOutline} disabled={decide.isPending} onClick={() => decide.mutate({ requestId: r.requestId, decision: "REJECT" })}>Reject</button>
              </div>
            ) : (
              <span className="text-muted-foreground">{r.requestedByMe ? "You requested this. Another approver must decide." : "A brand approver must decide."}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
