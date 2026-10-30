"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate, isValidEmail } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import {
  createContact,
  createSuppression,
  fetchAudiences,
  fetchContactProviderStates,
  fetchContacts,
  fetchSuppressions,
  importContacts,
  type ImportMode,
  type ImportResult,
  liftSuppression,
  withdrawConsent,
} from "@/lib/mail-marketing.service";
import type { ConsentSource, MarketingOrganization } from "@/types/mail-marketing.types";
import { EmBadge, EmCard, EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";
import ResubscriptionsPanel from "./ResubscriptionsPanel";

const SOURCES: ConsentSource[] = ["WEB_FORM", "EVENT", "MANUAL", "API", "IMPORT"];

function AddContact({ org, onDone }: { org: MarketingOrganization; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [topic, setTopic] = useState("newsletter");
  const [source, setSource] = useState<ConsentSource>("WEB_FORM");
  const [policyVersion, setPolicyVersion] = useState("");
  const [evidence, setEvidence] = useState("");
  const [doubleOptIn, setDoubleOptIn] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      createContact(org.id, {
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        consent: {
          topic: topic.trim(),
          source,
          policyVersion: policyVersion.trim(),
          doubleOptIn,
          evidence: { reference: evidence.trim(), capturedAt: new Date().toISOString() },
        },
      }),
    onSuccess: () => {
      setEmail("");
      setFirstName("");
      setLastName("");
      setEvidence("");
      setMsg(doubleOptIn ? "Contact added. Consent stays pending until the contact confirms." : "Contact added with recorded consent.");
      onDone();
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const valid = isValidEmail(email) && topic.trim() && policyVersion.trim() && evidence.trim();
  return (
    <form
      className="grid grid-cols-1 gap-2 rounded-md border border-border p-3 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) m.mutate();
      }}
      aria-label="Add contact"
    >
      <EmField label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={emInput} required /></EmField>
      <EmField label="First name"><input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={emInput} /></EmField>
      <EmField label="Last name"><input value={lastName} onChange={(e) => setLastName(e.target.value)} className={emInput} /></EmField>
      <EmField label="Consent topic"><input value={topic} onChange={(e) => setTopic(e.target.value)} className={emInput} required /></EmField>
      <EmField label="Consent source">
        <select value={source} onChange={(e) => setSource(e.target.value as ConsentSource)} className={emInput}>
          {SOURCES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
      </EmField>
      <EmField label="Privacy policy version"><input value={policyVersion} onChange={(e) => setPolicyVersion(e.target.value)} className={emInput} required placeholder="e.g. 2026-10" /></EmField>
      <div className="sm:col-span-2">
        <EmField label="Consent evidence" hint="Form submission ID, event sign-up sheet reference, etc. Required.">
          <input value={evidence} onChange={(e) => setEvidence(e.target.value)} className={emInput} required />
        </EmField>
      </div>
      <label className="flex items-center gap-2 self-end text-[12px]">
        <input type="checkbox" checked={doubleOptIn} onChange={(e) => setDoubleOptIn(e.target.checked)} /> Require double opt-in
      </label>
      <div className="sm:col-span-3 flex items-center gap-2">
        <button type="submit" className={emBtn} disabled={!valid || m.isPending}>Add contact</button>
        <EmMessage message={msg} />
      </div>
    </form>
  );
}

function ImportContacts({ org, onDone }: { org: MarketingOrganization; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const audiences = useQuery({ queryKey: ["mail", "marketing", org.id, "audiences"], queryFn: () => fetchAudiences(org.id), gcTime: 300000, retry: false });
  const [topic, setTopic] = useState("newsletter");
  const [source, setSource] = useState("IMPORT");
  const [policyVersion, setPolicyVersion] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [attest, setAttest] = useState(false);
  // Authors preview; a different brand approver commits the same file.
  const [mode, setMode] = useState<ImportMode>(org.canAuthor ? "preview" : "commit");
  const [fileSha256, setFileSha256] = useState("");
  const [report, setReport] = useState<ImportResult | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => {
      const file = fileRef.current?.files?.[0];
      if (!file) throw new Error("Choose a CSV file.");
      return importContacts(org.id, file, { topic, source, policyVersion, evidenceReference, audienceId: audienceId || undefined, attestOptIn: attest, mode, fileSha256: mode === "commit" ? fileSha256.trim() : undefined });
    },
    onSuccess: (r) => {
      setReport(r);
      setMsg(null);
      if (r.mode === "commit") onDone();
    },
    onError: (e) => setMsg(e instanceof Error && !("response" in e) ? e.message : classifyMailError(e).message),
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-muted-foreground">
        CSV with an <code>email</code> column (optional <code>first_name</code>, <code>last_name</code>, <code>consent_evidence</code>). Maximum 5,000 rows.
        Only import people who gave verifiable consent; purchased, scraped or product customer lists are not eligible.
      </p>
      <form
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <EmField label="CSV file"><input ref={fileRef} type="file" accept=".csv,text/csv" className="text-[12px]" required /></EmField>
        <EmField label="Consent topic"><input value={topic} onChange={(e) => setTopic(e.target.value)} className={emInput} required /></EmField>
        <EmField label="Consent source">
          <select value={source} onChange={(e) => setSource(e.target.value)} className={emInput}>
            {SOURCES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
          </select>
        </EmField>
        <EmField label="Policy version"><input value={policyVersion} onChange={(e) => setPolicyVersion(e.target.value)} className={emInput} required /></EmField>
        <EmField label="Evidence reference" hint="Where the consent records are held."><input value={evidenceReference} onChange={(e) => setEvidenceReference(e.target.value)} className={emInput} required /></EmField>
        <EmField label="Add to audience (optional)">
          <select value={audienceId} onChange={(e) => setAudienceId(e.target.value)} className={emInput}>
            <option value="">None</option>
            {(audiences.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </EmField>
        <EmField label="Step">
          <select value={mode} onChange={(e) => setMode(e.target.value as ImportMode)} className={emInput}>
            {org.canAuthor && <option value="preview">1. Preview (dry run)</option>}
            {org.canApprove && <option value="commit">2. Approve and import</option>}
          </select>
        </EmField>
        {mode === "commit" && (
          <EmField label="Preview fingerprint (sha256)" hint="From the preview; you must be a different person from the uploader.">
            <input value={fileSha256} onChange={(e) => setFileSha256(e.target.value)} className={emInput} pattern="[0-9a-fA-F]{64}" required />
          </EmField>
        )}
        <label className="sm:col-span-3 flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          I confirm every person in this file opted in to this topic and the evidence is held as referenced.
        </label>
        <div className="sm:col-span-3 flex items-center gap-2">
          <button type="submit" className={emBtn} disabled={m.isPending || !attest || !policyVersion.trim() || !evidenceReference.trim() || (mode === "commit" && !fileSha256.trim())}>
            {m.isPending ? "Working…" : mode === "preview" ? "Preview import" : "Approve and import"}
          </button>
          <EmMessage message={msg} tone="error" />
        </div>
      </form>
      {report && (
        <div role="status" className="rounded-md border border-border p-3 text-[12px]">
          <p className="font-semibold">
            {report.dryRun ? "Preview (nothing imported): " : ""}
            {report.total} rows · {report.created} {report.dryRun ? "new" : "created"} · {report.updated} updated · {report.skipped} skipped · {report.rejected} rejected
            {report.counts ? ` · ${report.counts.suppressed} suppressed · ${report.counts.skippedWithdrawn} withdrawn · ${report.counts.skippedPendingConfirmation} awaiting confirmation` : ""}
          </p>
          {report.dryRun && report.fileSha256 && (
            <p className="mt-1 break-all text-muted-foreground">
              Fingerprint <code>{report.fileSha256}</code>. A different brand approver must upload the same file with this fingerprint to import it.
            </p>
          )}
          {report.rows.some((r) => r.status === "REJECTED" || r.status === "SKIPPED") && (
            <div className="mt-2 max-h-56 overflow-auto">
              <table className="w-full text-left">
                <thead className="text-muted-foreground"><tr><th>Row</th><th>Line</th><th>Email</th><th>Result</th><th>Reason</th></tr></thead>
                <tbody>
                  {report.rows.filter((r) => r.status === "REJECTED" || r.status === "SKIPPED").map((r) => (
                    <tr key={r.row} className="border-t border-border">
                      <td>{r.row}</td><td>{r.line ?? "—"}</td><td>{r.email ?? "—"}</td><td>{r.status}</td><td>{r.reason ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Suppressions({ org }: { org: MarketingOrganization }) {
  const qc = useQueryClient();
  const key = ["mail", "marketing", org.id, "suppressions"];
  const q = useQuery({ queryKey: key, queryFn: () => fetchSuppressions(org.id), gcTime: 300000, retry: false });
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("MANUAL");
  const [msg, setMsg] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => createSuppression(org.id, { email: email.trim(), reason }),
    onSuccess: () => { setEmail(""); setMsg(null); qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const lift = useMutation({
    mutationFn: (id: string) => liftSuppression(org.id, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  return (
    <div className="flex flex-col gap-3">
      {org.canAuthor && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (isValidEmail(email)) add.mutate(); }}>
          <EmField label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={emInput} /></EmField>
          <EmField label="Reason">
            <select value={reason} onChange={(e) => setReason(e.target.value)} className={emInput}>
              <option value="MANUAL">Manual</option><option value="UNSUBSCRIBED">Unsubscribed</option><option value="LEGAL">Legal</option>
            </select>
          </EmField>
          <button type="submit" className={emBtn} disabled={!isValidEmail(email) || add.isPending}>Suppress</button>
        </form>
      )}
      <EmMessage message={msg} tone="error" />
      <PermissionBoundary isLoading={q.isLoading} error={q.error} compact>
        <table className="w-full text-left text-[12px]">
          <thead className="text-muted-foreground"><tr><th className="py-1">Email</th><th>Reason</th><th>Scope</th><th>Since</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {(q.data?.items ?? []).length === 0 && <tr><td colSpan={5} className="py-2 text-muted-foreground">No suppressions.</td></tr>}
            {(q.data?.items ?? []).map((s) => (
              <tr key={s.id} className="border-t border-border">
                <td className="py-1">{s.email}</td>
                <td>{s.reason}</td>
                <td>{s.organizationId ? "Brand" : "Global"}</td>
                <td>{formatFullDate(s.createdAt)}</td>
                <td className="text-right">
                  {s.liftedAt ? <span className="text-muted-foreground">Lifted</span> : org.canAuthor && s.reason === "MANUAL" && (
                    <button type="button" className="text-primary hover:underline" onClick={() => lift.mutate(s.id)}>Lift</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PermissionBoundary>
    </div>
  );
}

export default function ContactsPanel({ org }: { org: MarketingOrganization }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"contacts" | "add" | "import" | "suppressions" | "resubscriptions">("contacts");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const key = ["mail", "marketing", org.id, "contacts", query];
  const q = useQuery({ queryKey: key, queryFn: () => fetchContacts(org.id, { q: query || undefined }), gcTime: 300000, retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail", "marketing", org.id, "contacts"] });
  // Final gap 2: what the provider says about each listed contact (hidden
  // until the Mail database update that stores it is applied).
  const contactIds = (q.data?.items ?? []).map((c) => c.id);
  const providerStates = useQuery({
    queryKey: ["mail", "marketing", org.id, "provider-states", contactIds.join(",")],
    queryFn: () => fetchContactProviderStates(org.id, contactIds),
    enabled: contactIds.length > 0,
    gcTime: 300000,
    retry: false,
  });
  const providerStateOf = new Map((providerStates.data?.items ?? []).map((row) => [row.contactId, row]));
  const showProviderState = providerStates.isSuccess;
  const withdraw = useMutation({
    mutationFn: ({ contactId, topic }: { contactId: string; topic: string }) => withdrawConsent(org.id, contactId, topic),
    onSuccess: () => { setMsg("Consent withdrawn."); refresh(); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });

  const tabs = [
    { id: "contacts" as const, label: "Contacts" },
    ...(org.canAuthor ? [{ id: "add" as const, label: "Add contact" }] : []),
    ...(org.canAuthor || org.canApprove ? [{ id: "import" as const, label: "CSV import" }] : []),
    { id: "suppressions" as const, label: "Suppressions" },
    { id: "resubscriptions" as const, label: "Re-subscriptions" },
  ];

  return (
    <EmCard title="Contacts & consent" id="em-contacts">
      <div role="tablist" aria-label="Contacts sections" className="mb-3 flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`border-b-2 px-3 py-1.5 text-[12px] ${tab === t.id ? "border-primary font-semibold" : "border-transparent text-muted-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "add" && <AddContact org={org} onDone={refresh} />}
      {tab === "import" && <ImportContacts org={org} onDone={refresh} />}
      {tab === "suppressions" && <Suppressions org={org} />}
      {tab === "resubscriptions" && <ResubscriptionsPanel org={org} />}
      {tab === "contacts" && (
        <div className="flex flex-col gap-2">
          <form role="search" className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}>
            <label htmlFor="contact-search" className="sr-only">Search contacts</label>
            <input id="contact-search" value={search} onChange={(e) => setSearch(e.target.value)} className={emInput} placeholder="Search by email or name" />
            <button type="submit" className={emBtnOutline}>Search</button>
          </form>
          <EmMessage message={msg} />
          <PermissionBoundary isLoading={q.isLoading} error={q.error} retry={() => q.refetch()}>
            {(q.data?.items ?? []).length === 0 ? (
              <p role="status" className="p-4 text-center text-[12px] text-muted-foreground">No contacts.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="text-muted-foreground"><tr><th className="py-1">Email</th><th>Name</th><th>Status</th>{showProviderState && <th>Provider</th>}<th>Consents</th></tr></thead>
                  <tbody>
                    {(q.data?.items ?? []).map((c) => (
                      <tr key={c.id} className="border-t border-border align-top">
                        <td className="py-1.5">{c.email}</td>
                        <td>{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</td>
                        <td><EmBadge value={c.status} /></td>
                        {showProviderState && (
                          <td title={providerStateOf.get(c.id)?.reason ? `Provider reason: ${providerStateOf.get(c.id)?.reason}` : "What the email provider reports for this contact"}>
                            <EmBadge value={providerStateOf.get(c.id)?.state ?? "UNKNOWN"} />
                          </td>
                        )}
                        <td>
                          <ul className="flex flex-col gap-1">
                            {c.consents.length === 0 && <li className="text-muted-foreground">No consent recorded (not eligible)</li>}
                            {c.consents.map((k) => (
                              <li key={k.id} className="flex flex-wrap items-center gap-1.5">
                                <span className="font-semibold">{k.topic}</span>
                                <EmBadge value={k.status} />
                                <span className="text-muted-foreground">{k.source} · policy {k.policyVersion}</span>
                                {org.canAuthor && k.status !== "WITHDRAWN" && (
                                  <button
                                    type="button"
                                    className="text-red-600 hover:underline"
                                    onClick={() => window.confirm(`Withdraw ${k.topic} consent for ${c.email}?`) && withdraw.mutate({ contactId: c.id, topic: k.topic })}
                                  >
                                    Withdraw
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </PermissionBoundary>
        </div>
      )}
    </EmCard>
  );
}
