"use client";

import { Suspense, useCallback, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { mailKeys, useEntitlements, useLabels, useMailbox, useMembers } from "@/components/mail/hooks";
import { formatFullDate } from "@/components/mail/mail-utils";
import StaffPicker from "@/components/mail/StaffPicker";
import api from "@/lib/api";
import {
  addMember,
  classifyMailError,
  createLabel,
  revokeMember,
  updateMailboxSettings,
} from "@/lib/mail.service";
import type { MailboxSummary, MembershipRole, StaffDirectoryEntry } from "@/types/mail.types";

const card = "rounded-lg border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";

function Signature({ mailbox }: { mailbox: MailboxSummary }) {
  const qc = useQueryClient();
  const detail = useMailbox(mailbox.id);
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<typeof detail.data | null>(null);
  if (detail.data && seeded !== detail.data) {
    setSeeded(detail.data);
    setValue(detail.data.signatureHtml ?? "");
  }
  const save = useMutation({
    mutationFn: () => updateMailboxSettings(mailbox.id, { signatureHtml: value || null }),
    onSuccess: () => {
      setMsg("Signature saved.");
      qc.invalidateQueries({ queryKey: mailKeys.mailbox(mailbox.id) });
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const canEdit = mailbox.type === "PERSONAL" ? mailbox.role === "OWNER" : mailbox.role === "OWNER" || mailbox.role === "MANAGER";
  return (
    <section className={card} aria-labelledby="sig-h">
      <h2 id="sig-h" className="mb-2 text-[13px] font-semibold">Signature</h2>
      <PermissionBoundary isLoading={detail.isLoading} error={detail.error} compact>
        <label htmlFor="sig" className="sr-only">Signature</label>
        <textarea id="sig" rows={4} value={value} disabled={!canEdit} onChange={(e) => setValue(e.target.value)} className={input} placeholder="Signature (basic HTML is sanitized by the server)" />
        {canEdit ? (
          <button type="button" className={`${btn} mt-2`} disabled={save.isPending} onClick={() => save.mutate()}>Save signature</button>
        ) : (
          <p className="mt-1 text-[11px] text-muted-foreground">Only mailbox owners/managers can change the signature.</p>
        )}
        {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-muted-foreground">Approved sender identities</p>
          <ul className="text-[12px]">
            {(detail.data?.senderIdentities ?? []).length === 0 && <li className="text-muted-foreground">None. You cannot send from this mailbox.</li>}
            {(detail.data?.senderIdentities ?? []).map((s) => (
              <li key={s.addressId}>{s.displayName ? `${s.displayName} <${s.address}>` : s.address}</li>
            ))}
          </ul>
        </div>
      </PermissionBoundary>
    </section>
  );
}

function Labels({ mailbox }: { mailbox: MailboxSummary }) {
  const qc = useQueryClient();
  const labels = useLabels(mailbox.id);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#272EA7");
  const [msg, setMsg] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => createLabel(mailbox.id, { name: name.trim(), color }),
    onSuccess: () => {
      setName("");
      setMsg(null);
      qc.invalidateQueries({ queryKey: mailKeys.labels(mailbox.id) });
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  return (
    <section className={card} aria-labelledby="labels-h">
      <h2 id="labels-h" className="mb-2 text-[13px] font-semibold">Labels</h2>
      <PermissionBoundary isLoading={labels.isLoading} error={labels.error} compact>
        <ul className="mb-2 flex flex-wrap gap-1">
          {(labels.data ?? []).length === 0 && <li className="text-[12px] text-muted-foreground">No labels.</li>}
          {(labels.data ?? []).map((l) => (
            <li key={l.id} className="rounded border px-2 text-[11px]" style={{ borderColor: l.color ?? undefined }}>{l.name}</li>
          ))}
        </ul>
        {mailbox.role !== "READER" && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
            <label htmlFor="label-name" className="sr-only">Label name</label>
            <input id="label-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={input} placeholder="New label" />
            <label htmlFor="label-color" className="sr-only">Label colour</label>
            <input id="label-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-10 rounded border border-border" />
            <button type="submit" className={btn} disabled={!name.trim() || create.isPending}>Add</button>
          </form>
        )}
        {msg && <p role="alert" className="mt-1 text-[11px] text-red-600">{msg}</p>}
      </PermissionBoundary>
    </section>
  );
}

function Members({ mailbox }: { mailbox: MailboxSummary }) {
  const qc = useQueryClient();
  const canManage = mailbox.role === "OWNER" || mailbox.role === "MANAGER";
  const members = useMembers(mailbox.id, canManage);
  const [staff, setStaff] = useState<StaffDirectoryEntry | null>(null);
  const [directoryForbidden, setDirectoryForbidden] = useState(false);
  const onForbidden = useCallback(() => setDirectoryForbidden(true), []);
  const [role, setRole] = useState<MembershipRole>("MEMBER");
  const [canSend, setCanSend] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: mailKeys.members(mailbox.id) });
  const add = useMutation({
    mutationFn: () => addMember(mailbox.id, { adminUserId: (staff as StaffDirectoryEntry).id, role, canSend }),
    onSuccess: () => { setStaff(null); setMsg("Member added."); refresh(); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeMember(mailbox.id, id),
    onSuccess: () => { setMsg("Access revoked. It takes effect on the member's next request."); refresh(); },
    onError: (e) => setMsg(classifyMailError(e).message),
  });
  if (mailbox.type !== "SHARED") return null;
  return (
    <section className={card} aria-labelledby="members-h">
      <h2 id="members-h" className="mb-2 text-[13px] font-semibold">Shared mailbox members</h2>
      {!canManage ? (
        <p className="text-[12px] text-muted-foreground">Only mailbox owners and managers can view or change membership.</p>
      ) : (
        <PermissionBoundary isLoading={members.isLoading} error={members.error} compact>
          <table className="w-full text-left text-[12px]">
            <thead><tr className="text-muted-foreground"><th className="py-1">Member</th><th>Role</th><th>Can send</th><th>Since</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {(members.data ?? []).map((m) => (
                <tr key={m.id} className="border-t border-border">
                  <td className="py-1">{m.name || m.email || m.adminUserId}</td>
                  <td>{m.role}</td>
                  <td>{m.canSend ? "Yes" : "No"}</td>
                  <td>{formatFullDate(m.createdAt)}</td>
                  <td className="text-right">
                    <button type="button" className="text-red-600 hover:underline disabled:opacity-50" disabled={revoke.isPending}
                      onClick={() => window.confirm(`Revoke access for ${m.name || m.adminUserId}?`) && revoke.mutate(m.id)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {directoryForbidden ? (
            <p className="mt-3 text-[11px] text-muted-foreground">The staff directory is not available to your account, so members cannot be added here.</p>
          ) : (
          <form className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); if (staff) add.mutate(); }}>
            <div className="sm:col-span-2 flex flex-col gap-1 text-[11px] text-muted-foreground">Employee
              <StaffPicker value={staff} onChange={setStaff} onForbidden={onForbidden} />
            </div>
            <label className="text-[11px] text-muted-foreground">Role
              <select value={role} onChange={(e) => setRole(e.target.value as MembershipRole)} className={input}>
                <option value="MEMBER">Member</option><option value="READER">Reader</option><option value="MANAGER">Manager</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={canSend} onChange={(e) => setCanSend(e.target.checked)} /> Can send
            </label>
            <button type="submit" className={`${btn} sm:col-span-4 justify-self-start`} disabled={!staff || add.isPending}>Add member</button>
          </form>
          )}
        </PermissionBoundary>
      )}
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}

interface ProvisionRequest { id: string; type: string; status: string; requestedAddress: string | null; createdAt: string; reviewNote?: string | null }

function Provisioning({ organizationId }: { organizationId?: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["mail", "provisioning"],
    queryFn: async () => (await api.get<{ data: ProvisionRequest[] }>("/api/mail/v1/provisioning/requests")).data.data,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });
  const [type, setType] = useState("ALIAS");
  const [requestedAddress, setRequestedAddress] = useState("");
  const [justification, setJustification] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: async () =>
      (await api.post("/api/mail/v1/provisioning/requests", { organizationId, type, requestedAddress: requestedAddress.trim() || undefined, justification: justification.trim() })).data,
    onSuccess: () => { setMsg("Request submitted for approval."); setRequestedAddress(""); setJustification(""); qc.invalidateQueries({ queryKey: ["mail", "provisioning"] }); },
    onError: (e) => {
      const info = classifyMailError(e);
      setMsg(info.code === "DOMAIN_NOT_REGISTERED" ? "That address's domain is not registered with CosmicForge Mail. Ask a mail administrator to add the domain first." : info.message);
    },
  });
  return (
    <section className={card} aria-labelledby="prov-h">
      <h2 id="prov-h" className="mb-2 text-[13px] font-semibold">Address &amp; mailbox requests</h2>
      <form className="grid grid-cols-1 gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (justification.trim()) submit.mutate(); }}>
        <label className="text-[11px] text-muted-foreground">Request type
          <select value={type} onChange={(e) => setType(e.target.value)} className={input}>
            <option value="PERSONAL_MAILBOX">Personal mailbox</option>
            <option value="ALIAS">Alias address</option>
            <option value="SHARED_MAILBOX">Shared mailbox</option>
            <option value="SENDER_GRANT">Permission to send as an address</option>
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">Requested address
          <input value={requestedAddress} onChange={(e) => setRequestedAddress(e.target.value)} className={input} placeholder="name@company.com" />
        </label>
        <label className="sm:col-span-2 text-[11px] text-muted-foreground">Justification
          <textarea value={justification} onChange={(e) => setJustification(e.target.value)} rows={2} className={input} required />
        </label>
        <button type="submit" className={`${btn} justify-self-start`} disabled={!justification.trim() || submit.isPending}>Submit request</button>
      </form>
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
      <div className="mt-3">
        <PermissionBoundary isLoading={list.isLoading} error={list.error} compact>
          <ul className="text-[12px]">
            {(list.data ?? []).length === 0 && <li className="text-muted-foreground">No requests.</li>}
            {(list.data ?? []).map((r) => (
              <li key={r.id} className="flex gap-2 border-t border-border py-1">
                <span className="w-32">{r.type}</span><span className="flex-1">{r.requestedAddress ?? "—"}</span>
                <span className="font-semibold">{r.status}</span><span className="text-muted-foreground">{formatFullDate(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </PermissionBoundary>
      </div>
    </section>
  );
}

function SettingsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const ent = useEntitlements();
  const mailboxes = ent.data?.mailboxes ?? [];
  const selectedId = params.get("mailboxId") ?? mailboxes[0]?.id ?? "";
  const mailbox = mailboxes.find((m) => m.id === selectedId);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-center gap-2">
        <Link href={mailbox ? `/dashboard/mail/${mailbox.id}` : "/dashboard/mail"} aria-label="Back to mail" className="rounded p-1.5 hover:bg-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-[15px] font-semibold">Mail settings</h1>
        <Link href="/dashboard/mail/operations" className="ml-auto text-[12px] font-semibold text-primary hover:underline">Operations</Link>
        <Link href="/dashboard/mail/rollout" className="text-[12px] font-semibold text-primary hover:underline">Rollout</Link>
        <Link href="/dashboard/mail/integrations" className="text-[12px] font-semibold text-primary hover:underline">Product integrations</Link>
      </div>
      <PermissionBoundary isLoading={ent.isLoading} error={ent.error} retry={() => ent.refetch()}>
        {mailboxes.length > 0 && (
          <label className="text-[11px] text-muted-foreground">Mailbox
            <select value={selectedId} onChange={(e) => router.replace(`/dashboard/mail/settings?mailboxId=${e.target.value}`)} className={input}>
              {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.name}{m.type === "SHARED" ? " (shared)" : ""}</option>)}
            </select>
          </label>
        )}
        {mailbox && (
          <>
            <Signature key={`sig-${mailbox.id}`} mailbox={mailbox} />
            <Labels key={`lab-${mailbox.id}`} mailbox={mailbox} />
            <Members key={`mem-${mailbox.id}`} mailbox={mailbox} />
          </>
        )}
        {ent.data?.identityActive !== false && <Provisioning organizationId={mailbox?.organization.id} />}
      </PermissionBoundary>
    </div>
  );
}

export default function MailSettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsInner />
    </Suspense>
  );
}
