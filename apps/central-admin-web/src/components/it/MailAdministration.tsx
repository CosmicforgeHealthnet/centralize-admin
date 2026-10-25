"use client";

// IT > Mail Administration (spec §15, §16.1, §24): domains and DNS status,
// shared mailboxes, provisioning approvals, send-as grants, legal holds and
// retention policies, and redacted audit/webhook/delivery/job views.
// Everything is authorized by the API (mail.admin VIEW/EDIT); this page never
// shows message content, provider keys or secrets, and the SUPER tier gets no
// private mailbox access from it.

import { Fragment, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { useEntitlements } from "@/components/mail/hooks";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import * as adminApi from "@/lib/mail-admin.service";
import type { AdminDomain, ProvisionRequest } from "@/types/mail-admin.types";

type Tab = "domains" | "mailboxes" | "provisioning" | "grants" | "holds" | "audit";
const TABS: { id: Tab; label: string }[] = [
  { id: "domains", label: "Domains" },
  { id: "mailboxes", label: "Shared mailboxes" },
  { id: "provisioning", label: "Provisioning" },
  { id: "grants", label: "Send-as grants" },
  { id: "holds", label: "Legal holds & retention" },
  { id: "audit", label: "Audit & events" },
];

const card = "rounded-xl border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";
const ghost = "rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50";
const th = "py-1.5 pr-3 text-left text-[11px] font-semibold text-muted-foreground";
const td = "py-1.5 pr-3 align-top text-[12px]";
const FORBIDDEN = "Mail administration is available to mail administrators only.";
const qk = (...parts: string[]) => ["mail", "admin", ...parts];

const STATUS_TONE: Record<string, string> = {
  VERIFIED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  ACTIVE: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  PROVISIONED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  FAILED: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  REJECTED: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  SUSPENDED: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  DISABLED: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  DEAD_LETTER: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  PENDING: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  PENDING_VERIFICATION: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
};

function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_TONE[value] || "bg-muted text-muted-foreground"}`}>{value.replace(/_/g, " ").toLowerCase()}</span>;
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  const info = classifyMailError(error);
  const reason = (info.detail?.reason as string | undefined) || (info.detail?.field ? `field: ${String(info.detail.field)}` : "");
  return (
    <p role="alert" className="text-[11px] text-red-700 dark:text-red-300">
      {info.message}
      {reason ? ` (${reason})` : ""}
    </p>
  );
}

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section className={card} aria-labelledby={id}>
      <h3 id={id} className="text-[13px] font-semibold">{title}</h3>
      {description && <p className="mb-2 text-[11px] text-muted-foreground">{description}</p>}
      <div className="mt-2 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Table({ caption, head, children, empty }: { caption: string; head: string[]; children: ReactNode; empty: boolean }) {
  if (empty) return <p className="text-[12px] text-muted-foreground">Nothing to show.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">{head.map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function useOrganizations() {
  return useQuery({ queryKey: qk("organizations"), queryFn: adminApi.listOrganizations, retry: false });
}

function OrgSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const orgs = useOrganizations();
  return (
    <select id={id} className={input} value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">Select brand…</option>
      {(orgs.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name} ({o.slug})</option>)}
    </select>
  );
}

// ── Domains ──────────────────────────────────────────────────────────────
function DnsRecords({ domain }: { domain: AdminDomain }) {
  const records = Array.isArray(domain.dnsRecords) ? domain.dnsRecords : [];
  if (!records.length) return <p className="text-[11px] text-muted-foreground">No DNS records reported yet. Run a verification check.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {records.map((r, i) => (
        <li key={`${r.type}-${r.name}-${i}`} className="break-all text-[11px]">
          <span className="font-semibold">{r.record || r.type}</span> {r.type} <code>{r.name}</code> → <code>{r.value}</code> <Badge value={r.status ? r.status.toUpperCase() : null} />
        </li>
      ))}
    </ul>
  );
}

function Domains({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const orgs = useOrganizations();
  const domains = useQuery({ queryKey: qk("domains"), queryFn: adminApi.listDomains, retry: false });
  const [org, setOrg] = useState({ slug: "", name: "", kind: "BRAND" as "BRAND" | "COMPANY" });
  const [dom, setDom] = useState({ organizationId: "", domain: "", providerDomainId: "" });
  const [open, setOpen] = useState<string | null>(null);
  const createOrg = useMutation({ mutationFn: adminApi.createOrganization, onSuccess: () => { setOrg({ slug: "", name: "", kind: "BRAND" }); qc.invalidateQueries({ queryKey: qk("organizations") }); } });
  const createDom = useMutation({ mutationFn: adminApi.createDomain, onSuccess: () => { setDom({ organizationId: "", domain: "", providerDomainId: "" }); qc.invalidateQueries({ queryKey: qk("domains") }); } });
  const verify = useMutation({ mutationFn: adminApi.verifyDomain, onSuccess: () => qc.invalidateQueries({ queryKey: qk("domains") }) });
  return (
    <>
      <Section id="mail-admin-domains" title="Sending and receiving domains" description="Domains must be on the server allowlist and verified with the provider before any external mail is sent. DNS changes are made by the domain owner outside this page.">
        <PermissionBoundary isLoading={domains.isLoading} error={domains.error} compact forbiddenMessage={FORBIDDEN}>
          <Table caption="Mail domains" head={["Domain", "Brand", "Status", "Sending", "Receiving", "Last checked", ""]} empty={!domains.data?.length}>
            {(domains.data ?? []).map((d) => (
              <Fragment key={d.id}>
                <tr className="border-b border-border/60">
                  <td className={td}><button type="button" className="font-semibold underline-offset-2 hover:underline" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>{d.domain}</button></td>
                  <td className={td}>{d.organization?.name ?? "—"}</td>
                  <td className={td}><Badge value={d.status} /></td>
                  <td className={td}><Badge value={d.sendingStatus} /></td>
                  <td className={td}><Badge value={d.receivingStatus} /></td>
                  <td className={td}>{formatFullDate(d.lastCheckedAt) || "Never"}</td>
                  <td className={td}>
                    {canEdit && (
                      <button type="button" className={ghost} disabled={verify.isPending || !d.providerDomainId} title={d.providerDomainId ? undefined : "Add the provider domain id first"} onClick={() => verify.mutate(d.id)}>
                        Check DNS
                      </button>
                    )}
                  </td>
                </tr>
                {open === d.id && (
                  <tr>
                    <td colSpan={7} className="pb-3"><DnsRecords domain={d} /></td>
                  </tr>
                )}
              </Fragment>
            ))}
          </Table>
          <ErrorLine error={verify.error} />
        </PermissionBoundary>
      </Section>
      {canEdit && (
        <div className="grid gap-3 md:grid-cols-2">
          <Section id="mail-admin-new-org" title="Add brand">
            <form className="flex flex-col gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); createOrg.mutate(org); }}>
              <label className="text-[11px] font-semibold" htmlFor="org-name">Name</label>
              <input id="org-name" className={input} value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} required />
              <label className="text-[11px] font-semibold" htmlFor="org-slug">Slug</label>
              <input id="org-slug" className={input} value={org.slug} onChange={(e) => setOrg({ ...org, slug: e.target.value })} pattern="[a-z0-9][a-z0-9-]{1,62}" required />
              <label className="text-[11px] font-semibold" htmlFor="org-kind">Kind</label>
              <select id="org-kind" className={input} value={org.kind} onChange={(e) => setOrg({ ...org, kind: e.target.value as "BRAND" | "COMPANY" })}>
                <option value="BRAND">Brand</option>
                <option value="COMPANY">Company</option>
              </select>
              <ErrorLine error={createOrg.error} />
              <button type="submit" className={btn} disabled={createOrg.isPending}>Add brand</button>
            </form>
          </Section>
          <Section id="mail-admin-new-domain" title="Register domain">
            <form className="flex flex-col gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); createDom.mutate({ ...dom, providerDomainId: dom.providerDomainId || undefined }); }}>
              <label className="text-[11px] font-semibold" htmlFor="dom-org">Brand</label>
              <OrgSelect id="dom-org" value={dom.organizationId} onChange={(organizationId) => setDom({ ...dom, organizationId })} />
              <label className="text-[11px] font-semibold" htmlFor="dom-name">Domain</label>
              <input id="dom-name" className={input} value={dom.domain} onChange={(e) => setDom({ ...dom, domain: e.target.value })} placeholder="example.com" required />
              <label className="text-[11px] font-semibold" htmlFor="dom-provider">Provider domain id (optional)</label>
              <input id="dom-provider" className={input} value={dom.providerDomainId} onChange={(e) => setDom({ ...dom, providerDomainId: e.target.value })} />
              <ErrorLine error={createDom.error} />
              <button type="submit" className={btn} disabled={createDom.isPending || !orgs.data?.length}>Register domain</button>
            </form>
          </Section>
        </div>
      )}
    </>
  );
}

// ── Shared mailboxes ─────────────────────────────────────────────────────
function Mailboxes({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const mailboxes = useQuery({ queryKey: qk("mailboxes"), queryFn: adminApi.listMailboxes, retry: false });
  const domains = useQuery({ queryKey: qk("domains"), queryFn: adminApi.listDomains, retry: false, enabled: canEdit });
  const [form, setForm] = useState({ organizationId: "", name: "", purpose: "GENERAL", domainId: "", localPart: "" });
  const create = useMutation({ mutationFn: adminApi.createSharedMailbox, onSuccess: () => { setForm({ organizationId: "", name: "", purpose: "GENERAL", domainId: "", localPart: "" }); qc.invalidateQueries({ queryKey: qk("mailboxes") }); } });
  const status = useMutation({ mutationFn: ({ id, action }: { id: string; action: "suspend" | "reactivate" }) => adminApi.setMailboxStatus(id, action), onSuccess: () => qc.invalidateQueries({ queryKey: qk("mailboxes") }) });
  const orgDomains = (domains.data ?? []).filter((d) => d.organizationId === form.organizationId);
  return (
    <>
      <Section id="mail-admin-mailboxes" title="Mailboxes" description="Directory only. Administrators cannot open private mailboxes from here; access comes from membership.">
        <PermissionBoundary isLoading={mailboxes.isLoading} error={mailboxes.error} compact forbiddenMessage={FORBIDDEN}>
          <Table caption="Mailboxes" head={["Name", "Type", "Addresses", "Members", "Status", ""]} empty={!mailboxes.data?.length}>
            {(mailboxes.data ?? []).map((m) => (
              <tr key={m.id} className="border-b border-border/60">
                <td className={td}>{m.name}{m.owner ? <span className="block text-[10px] text-muted-foreground">Owner: {m.owner.name || m.owner.email}</span> : null}</td>
                <td className={td}>{m.type === "SHARED" ? `Shared · ${m.purpose ?? ""}` : "Personal"}</td>
                <td className={td}>{m.addresses.map((a) => <span key={a.id} className="block break-all">{a.address}</span>)}</td>
                <td className={td}>{m.memberCount}</td>
                <td className={td}><Badge value={m.status} /></td>
                <td className={td}>
                  {canEdit && (m.status === "ACTIVE" ? (
                    <button type="button" className={ghost} disabled={status.isPending} onClick={() => window.confirm(`Suspend ${m.name}? Sending and receiving stop; history is kept.`) && status.mutate({ id: m.id, action: "suspend" })}>Suspend</button>
                  ) : (
                    <button type="button" className={ghost} disabled={status.isPending} onClick={() => status.mutate({ id: m.id, action: "reactivate" })}>Reactivate</button>
                  ))}
                </td>
              </tr>
            ))}
          </Table>
          <ErrorLine error={status.error} />
        </PermissionBoundary>
      </Section>
      {canEdit && (
        <Section id="mail-admin-new-mailbox" title="Create shared mailbox" description="Personal mailboxes are created by approving an HR provisioning request.">
          <form className="grid gap-2 md:grid-cols-2" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(form); }}>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold" htmlFor="mb-org">Brand</label>
              <OrgSelect id="mb-org" value={form.organizationId} onChange={(organizationId) => setForm({ ...form, organizationId, domainId: "" })} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold" htmlFor="mb-name">Name</label>
              <input id="mb-name" className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold" htmlFor="mb-purpose">Purpose</label>
              <select id="mb-purpose" className={input} value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })}>
                <option value="GENERAL">General</option>
                <option value="SUPPORT">Support</option>
                <option value="MARKETING">Marketing</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold" htmlFor="mb-address">Address</label>
              <div className="flex items-center gap-1">
                <input id="mb-address" aria-label="Local part" className={input} value={form.localPart} onChange={(e) => setForm({ ...form, localPart: e.target.value })} required />
                <span aria-hidden="true">@</span>
                <select aria-label="Domain" className={input} value={form.domainId} onChange={(e) => setForm({ ...form, domainId: e.target.value })} required>
                  <option value="">Domain…</option>
                  {orgDomains.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
                </select>
              </div>
            </div>
            <div className="md:col-span-2 flex flex-col gap-2">
              <ErrorLine error={create.error} />
              <button type="submit" className={btn} disabled={create.isPending}>Create shared mailbox</button>
            </div>
          </form>
        </Section>
      )}
    </>
  );
}

// ── Provisioning approvals ───────────────────────────────────────────────
const TYPE_LABEL: Record<string, string> = { PERSONAL_MAILBOX: "Personal mailbox", SHARED_MAILBOX: "Shared mailbox", ALIAS: "Alias", SENDER_GRANT: "Send-as" };

function ProvisioningRow({ request, canDecide }: { request: ProvisionRequest; canDecide: boolean }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const decide = useMutation({ mutationFn: (approve: boolean) => adminApi.decideProvisionRequest(request.id, approve, note || undefined), onSuccess: () => qc.invalidateQueries({ queryKey: qk() }) });
  return (
    <tr className="border-b border-border/60">
      <td className={td}>{TYPE_LABEL[request.type] ?? request.type}</td>
      <td className={`${td} break-all`}>{request.requestedAddress ?? "—"}</td>
      <td className={td}>{request.justification ?? "—"}</td>
      <td className={td}>{formatFullDate(request.createdAt)}</td>
      <td className={td}><Badge value={request.status} /></td>
      <td className={td}>
        {canDecide && request.status === "PENDING" && (
          <div className="flex flex-col gap-1">
            <input aria-label={`Review note for ${request.requestedAddress ?? request.id}`} className={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
            <div className="flex gap-1">
              <button type="button" className={btn} disabled={decide.isPending} onClick={() => decide.mutate(true)}>Approve</button>
              <button type="button" className={ghost} disabled={decide.isPending} onClick={() => decide.mutate(false)}>Reject</button>
            </div>
            <ErrorLine error={decide.error} />
          </div>
        )}
      </td>
    </tr>
  );
}

function Provisioning({ canEdit }: { canEdit: boolean }) {
  const requests = useQuery({ queryKey: qk("provisioning"), queryFn: adminApi.listProvisionRequests, retry: false });
  const [showAll, setShowAll] = useState(false);
  const rows = (requests.data ?? []).filter((r) => showAll || r.status === "PENDING");
  return (
    <Section id="mail-admin-provisioning" title="Provisioning requests" description="HR raises requests during onboarding; a mail administrator other than the requester approves. Approval creates the mailbox and address.">
      <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include decided requests
      </label>
      <PermissionBoundary isLoading={requests.isLoading} error={requests.error} compact forbiddenMessage={FORBIDDEN}>
        <Table caption="Provisioning requests" head={["Type", "Requested address", "Justification", "Requested", "Status", ""]} empty={!rows.length}>
          {rows.map((r) => <ProvisioningRow key={r.id} request={r} canDecide={canEdit} />)}
        </Table>
      </PermissionBoundary>
    </Section>
  );
}

// ── Send-as grants ───────────────────────────────────────────────────────
function Grants({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const grants = useQuery({ queryKey: qk("grants"), queryFn: () => adminApi.listSenderGrants(), retry: false });
  const revoke = useMutation({ mutationFn: adminApi.revokeSenderGrant, onSuccess: () => qc.invalidateQueries({ queryKey: qk("grants") }) });
  return (
    <Section id="mail-admin-grants" title="Send-as grants" description="Who may send as a shared identity. Members are added from the mailbox settings page; a grant needs an existing membership.">
      <PermissionBoundary isLoading={grants.isLoading} error={grants.error} compact forbiddenMessage={FORBIDDEN}>
        <Table caption="Active send-as grants" head={["Identity", "Mailbox", "Member", "Expires", ""]} empty={!grants.data?.length}>
          {(grants.data ?? []).map((g) => (
            <tr key={g.id} className="border-b border-border/60">
              <td className={`${td} break-all`}>{g.address.address}</td>
              <td className={td}>{g.mailbox.name}</td>
              <td className={td}>{g.member.name || g.member.email}</td>
              <td className={td}>{g.expiresAt ? formatFullDate(g.expiresAt) : "No expiry"}</td>
              <td className={td}>{canEdit && <button type="button" className={ghost} disabled={revoke.isPending} onClick={() => window.confirm(`Revoke send-as ${g.address.address} for ${g.member.name || g.member.email}?`) && revoke.mutate(g.id)}>Revoke</button>}</td>
            </tr>
          ))}
        </Table>
        <ErrorLine error={revoke.error} />
      </PermissionBoundary>
    </Section>
  );
}

// ── Legal holds & retention ──────────────────────────────────────────────
function Holds({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const holds = useQuery({ queryKey: qk("holds"), queryFn: adminApi.listLegalHolds, retry: false });
  const policies = useQuery({ queryKey: qk("retention"), queryFn: adminApi.listRetentionPolicies, retry: false });
  const orgs = useOrganizations();
  const orgName = (id: string) => orgs.data?.find((o) => o.id === id)?.name ?? id;
  const [hold, setHold] = useState({ organizationId: "", reason: "" });
  const [policy, setPolicy] = useState({ organizationId: "", name: "", retainDays: 365, action: "ARCHIVE" as "ARCHIVE" | "DELETE" });
  const createHold = useMutation({ mutationFn: adminApi.createLegalHold, onSuccess: () => { setHold({ organizationId: "", reason: "" }); qc.invalidateQueries({ queryKey: qk("holds") }); } });
  const release = useMutation({ mutationFn: adminApi.releaseLegalHold, onSuccess: () => qc.invalidateQueries({ queryKey: qk("holds") }) });
  const createPolicy = useMutation({ mutationFn: adminApi.createRetentionPolicy, onSuccess: () => { setPolicy({ organizationId: "", name: "", retainDays: 365, action: "ARCHIVE" }); qc.invalidateQueries({ queryKey: qk("retention") }); } });
  return (
    <>
      <Section id="mail-admin-holds" title="Legal holds" description="A held brand or mailbox is excluded from every retention run until the hold is released.">
        <PermissionBoundary isLoading={holds.isLoading} error={holds.error} compact forbiddenMessage={FORBIDDEN}>
          <Table caption="Legal holds" head={["Brand", "Scope", "Reason", "Created", "Status", ""]} empty={!holds.data?.length}>
            {(holds.data ?? []).map((h) => (
              <tr key={h.id} className="border-b border-border/60">
                <td className={td}>{orgName(h.organizationId)}</td>
                <td className={td}>{h.mailboxId ? "Mailbox" : h.subjectAdminUserId ? "Person" : "Whole brand"}</td>
                <td className={td}>{h.reason}</td>
                <td className={td}>{formatFullDate(h.createdAt)}</td>
                <td className={td}><Badge value={h.releasedAt ? "RELEASED" : "ACTIVE"} /></td>
                <td className={td}>{canEdit && !h.releasedAt && <button type="button" className={ghost} disabled={release.isPending} onClick={() => window.confirm("Release this legal hold? Retention may then apply.") && release.mutate(h.id)}>Release</button>}</td>
              </tr>
            ))}
          </Table>
          <ErrorLine error={release.error} />
        </PermissionBoundary>
        {canEdit && (
          <form className="flex flex-col gap-2 border-t border-border pt-3" onSubmit={(e: FormEvent) => { e.preventDefault(); createHold.mutate(hold); }}>
            <label className="text-[11px] font-semibold" htmlFor="hold-org">Brand</label>
            <OrgSelect id="hold-org" value={hold.organizationId} onChange={(organizationId) => setHold({ ...hold, organizationId })} />
            <label className="text-[11px] font-semibold" htmlFor="hold-reason">Reason (at least 10 characters)</label>
            <textarea id="hold-reason" className={input} rows={2} minLength={10} value={hold.reason} onChange={(e) => setHold({ ...hold, reason: e.target.value })} required />
            <ErrorLine error={createHold.error} />
            <button type="submit" className={btn} disabled={createHold.isPending}>Place legal hold</button>
          </form>
        )}
      </Section>
      <Section id="mail-admin-retention" title="Retention policies" description="Policies define how long mail is kept. Retention runs (dry run first) are started from Mail operations.">
        <PermissionBoundary isLoading={policies.isLoading} error={policies.error} compact forbiddenMessage={FORBIDDEN}>
          <Table caption="Retention policies" head={["Name", "Brand", "Keep for", "Then"]} empty={!policies.data?.length}>
            {(policies.data ?? []).map((p) => (
              <tr key={p.id} className="border-b border-border/60">
                <td className={td}>{p.name}</td>
                <td className={td}>{orgName(p.organizationId)}</td>
                <td className={td}>{p.retainDays} days</td>
                <td className={td}>{p.action === "DELETE" ? "Delete" : "Archive"}</td>
              </tr>
            ))}
          </Table>
        </PermissionBoundary>
        {canEdit && (
          <form className="grid gap-2 border-t border-border pt-3 md:grid-cols-2" onSubmit={(e: FormEvent) => { e.preventDefault(); createPolicy.mutate(policy); }}>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold" htmlFor="ret-org">Brand</label>
              <OrgSelect id="ret-org" value={policy.organizationId} onChange={(organizationId) => setPolicy({ ...policy, organizationId })} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold" htmlFor="ret-name">Name</label>
              <input id="ret-name" className={input} value={policy.name} onChange={(e) => setPolicy({ ...policy, name: e.target.value })} required />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold" htmlFor="ret-days">Keep for (days, 30–36500)</label>
              <input id="ret-days" type="number" min={30} max={36500} className={input} value={policy.retainDays} onChange={(e) => setPolicy({ ...policy, retainDays: Number(e.target.value) })} required />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold" htmlFor="ret-action">Then</label>
              <select id="ret-action" className={input} value={policy.action} onChange={(e) => setPolicy({ ...policy, action: e.target.value as "ARCHIVE" | "DELETE" })}>
                <option value="ARCHIVE">Archive</option>
                <option value="DELETE">Delete</option>
              </select>
            </div>
            <div className="md:col-span-2 flex flex-col gap-2">
              <ErrorLine error={createPolicy.error} />
              <button type="submit" className={btn} disabled={createPolicy.isPending}>Add retention policy</button>
            </div>
          </form>
        )}
      </Section>
    </>
  );
}

// ── Audit & events (redacted) ────────────────────────────────────────────
function Audit() {
  const [action, setAction] = useState("");
  const [jobStatus, setJobStatus] = useState("DEAD_LETTER");
  const audits = useQuery({ queryKey: qk("audit", action), queryFn: () => adminApi.listAuditEvents(action ? { action } : {}), retry: false });
  const webhooks = useQuery({ queryKey: qk("webhooks"), queryFn: () => adminApi.listWebhookEvents(), retry: false });
  const deliveries = useQuery({ queryKey: qk("deliveries"), queryFn: adminApi.listDeliveryEvents, retry: false });
  const jobs = useQuery({ queryKey: qk("jobs", jobStatus), queryFn: () => adminApi.listJobs(jobStatus ? { status: jobStatus } : {}), retry: false });
  return (
    <>
      <Section id="mail-admin-audit" title="Access and administration audit" description="Who did what, when. Message content is never recorded here.">
        <label className="text-[11px] font-semibold" htmlFor="audit-action">Filter by action</label>
        <input id="audit-action" className={input} value={action} onChange={(e) => setAction(e.target.value.trim().toUpperCase())} placeholder="e.g. MAIL_BREAK_GLASS_ACCESS" />
        <PermissionBoundary isLoading={audits.isLoading} error={audits.error} compact forbiddenMessage={FORBIDDEN}>
          <Table caption="Mail audit events" head={["When", "Action", "Target", "Actor", "Outcome"]} empty={!audits.data?.length}>
            {(audits.data ?? []).map((a) => (
              <tr key={a.id} className="border-b border-border/60">
                <td className={td}>{formatFullDate(a.createdAt)}</td>
                <td className={td}><code>{a.action}</code></td>
                <td className={`${td} break-all`}>{a.targetType ?? "—"}{a.targetId ? ` · ${a.targetId.slice(0, 8)}` : ""}</td>
                <td className={td}>{a.actorAdminUserId ? a.actorAdminUserId.slice(0, 8) : "system"}</td>
                <td className={td}><Badge value={a.outcome} /></td>
              </tr>
            ))}
          </Table>
        </PermissionBoundary>
      </Section>
      <div className="grid gap-3 lg:grid-cols-2">
        <Section id="mail-admin-webhooks" title="Provider webhook events" description="Signature-verified events and processing lag. Payloads are not shown.">
          <PermissionBoundary isLoading={webhooks.isLoading} error={webhooks.error} compact forbiddenMessage={FORBIDDEN}>
            <Table caption="Webhook events" head={["Received", "Type", "Status", "Lag"]} empty={!webhooks.data?.length}>
              {(webhooks.data ?? []).map((w) => (
                <tr key={w.id} className="border-b border-border/60">
                  <td className={td}>{formatFullDate(w.receivedAt)}</td>
                  <td className={td}><code>{w.eventType}</code></td>
                  <td className={td}><Badge value={w.status} />{w.lastError ? <span className="block text-[10px] text-muted-foreground">{w.lastError}</span> : null}</td>
                  <td className={td}>{w.lagSeconds == null ? "—" : `${w.lagSeconds}s`}</td>
                </tr>
              ))}
            </Table>
          </PermissionBoundary>
        </Section>
        <Section id="mail-admin-deliveries" title="Delivery events" description="Recipients are reduced to their domain.">
          <PermissionBoundary isLoading={deliveries.isLoading} error={deliveries.error} compact forbiddenMessage={FORBIDDEN}>
            <Table caption="Delivery events" head={["When", "Event", "Recipient domain"]} empty={!deliveries.data?.length}>
              {(deliveries.data ?? []).map((d) => (
                <tr key={d.id} className="border-b border-border/60">
                  <td className={td}>{formatFullDate(d.occurredAt)}</td>
                  <td className={td}><code>{d.eventType}</code></td>
                  <td className={td}>{d.recipientDomain ?? "—"}</td>
                </tr>
              ))}
            </Table>
          </PermissionBoundary>
        </Section>
      </div>
      <Section id="mail-admin-jobs" title="Jobs and dead letters" description="Exhausted jobs are kept for review; nothing is resent automatically.">
        <label className="text-[11px] font-semibold" htmlFor="job-status">Status</label>
        <select id="job-status" className={input} value={jobStatus} onChange={(e) => setJobStatus(e.target.value)}>
          <option value="DEAD_LETTER">Dead letters</option>
          <option value="FAILED">Failed</option>
          <option value="RETRY_SCHEDULED">Retry scheduled</option>
          <option value="PENDING">Pending</option>
          <option value="LEASED">In progress</option>
          <option value="SUCCEEDED">Succeeded</option>
          <option value="">All</option>
        </select>
        <PermissionBoundary isLoading={jobs.isLoading} error={jobs.error} compact forbiddenMessage={FORBIDDEN}>
          <Table caption="Mail jobs" head={["Updated", "Queue", "Kind", "Status", "Attempts", "Last error"]} empty={!jobs.data?.length}>
            {(jobs.data ?? []).map((j) => (
              <tr key={j.id} className="border-b border-border/60">
                <td className={td}>{formatFullDate(j.updatedAt)}</td>
                <td className={td}>{j.queue}</td>
                <td className={td}><code>{j.kind}</code></td>
                <td className={td}><Badge value={j.status} /></td>
                <td className={td}>{j.attemptCount}/{j.maxAttempts}</td>
                <td className={td}>{j.lastErrorCode ?? "—"}</td>
              </tr>
            ))}
          </Table>
        </PermissionBoundary>
      </Section>
    </>
  );
}

export default function MailAdministration() {
  const ents = useEntitlements();
  const [tab, setTab] = useState<Tab>("domains");
  const canEdit = Boolean(ents.data?.canManageDomains);
  const canView = Boolean(ents.data?.canViewAdministration ?? ents.data?.canManageDomains);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-poppins text-[15px] font-semibold">Mail Administration</h2>
        <p className="text-[12px] text-muted-foreground">CosmicForge Mail domains, mailboxes, approvals and audit. Provider keys and DNS credentials are never shown here.</p>
      </div>
      <PermissionBoundary isLoading={ents.isLoading} error={ents.error} forbiddenMessage={FORBIDDEN}>
        {ents.data && !ents.data.mailEnabled && (
          <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-[12px]">CosmicForge Mail is turned off for this environment. Administration becomes available once Mail is enabled.</p>
        )}
        {ents.data?.mailEnabled && !canView && (
          <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-[12px]">{FORBIDDEN}</p>
        )}
        {ents.data?.mailEnabled && canView && (
          <>
            <div role="tablist" aria-label="Mail administration sections" className="flex flex-wrap gap-1.5">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`mail-admin-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls="mail-admin-panel"
                  onClick={() => setTab(t.id)}
                  className={`rounded-[8px] border px-3 py-1.5 text-[12px] font-poppins ${tab === t.id ? "border-primary bg-primary font-semibold text-white" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {!canEdit && <p className="text-[11px] text-muted-foreground">Read-only: you can view Mail administration but not change it.</p>}
            <div id="mail-admin-panel" role="tabpanel" aria-labelledby={`mail-admin-tab-${tab}`} className="flex flex-col gap-3">
              {tab === "domains" && <Domains canEdit={canEdit} />}
              {tab === "mailboxes" && <Mailboxes canEdit={canEdit} />}
              {tab === "provisioning" && <Provisioning canEdit={canEdit} />}
              {tab === "grants" && <Grants canEdit={canEdit} />}
              {tab === "holds" && <Holds canEdit={canEdit} />}
              {tab === "audit" && <Audit />}
            </div>
          </>
        )}
      </PermissionBoundary>
    </div>
  );
}
