"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import StaffPicker from "@/components/mail/StaffPicker";
import { classifyMailError } from "@/lib/mail.service";
import * as mailAdmin from "@/lib/mail-admin.service";
import { useAuthStore } from "@/stores/auth.store";
import type { StaffDirectoryEntry } from "@/types/mail.types";

const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const button = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";
const qk = (...parts: string[]) => ["mail", "admin", ...parts];

export default function PersonalMailboxForm() {
  const currentUser = useAuthStore((state) => state.user);
  const qc = useQueryClient();
  const organizations = useQuery({ queryKey: qk("organizations"), queryFn: mailAdmin.listOrganizations, retry: false });
  const domains = useQuery({ queryKey: qk("domains"), queryFn: mailAdmin.listDomains, retry: false });
  const mailboxes = useQuery({ queryKey: qk("mailboxes"), queryFn: mailAdmin.listMailboxes, retry: false });
  const [ownerMode, setOwnerMode] = useState<"SELF" | "STAFF">("SELF");
  const [staff, setStaff] = useState<StaffDirectoryEntry | null>(null);
  const [directoryForbidden, setDirectoryForbidden] = useState(false);
  const [form, setForm] = useState({ organizationId: "", domainId: "", name: "", localPart: "" });
  const [created, setCreated] = useState<string | null>(null);

  const targetId = ownerMode === "SELF" ? currentUser?.id : staff?.id;
  const targetName = ownerMode === "SELF" ? currentUser?.name : staff?.name;
  const existing = (mailboxes.data ?? []).find(
    (mailbox) => mailbox.type === "PERSONAL" && mailbox.owner?.id === targetId
  );
  const availableDomains = (domains.data ?? []).filter(
    (domain) => domain.organizationId === form.organizationId && domain.status === "VERIFIED"
  );
  const chosenDomain = availableDomains.find((domain) => domain.id === form.domainId);
  const canSubmit = Boolean(targetId && !existing && chosenDomain && form.localPart.trim() && !mailboxes.isLoading);

  const create = useMutation({
    mutationFn: () => mailAdmin.createPersonalMailbox({
      organizationId: form.organizationId,
      ownerAdminUserId: targetId as string,
      name: form.name.trim() || targetName || "Personal mailbox",
      domainId: form.domainId,
      localPart: form.localPart.trim(),
    }),
    onSuccess: async () => {
      const address = form.localPart.trim() + "@" + chosenDomain?.domain;
      setCreated(address);
      setForm({ organizationId: "", domainId: "", name: "", localPart: "" });
      setStaff(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk("mailboxes") }),
        qc.invalidateQueries({ queryKey: ["mail", "entitlements"] }),
      ]);
    },
  });

  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="mail-personal-new-heading">
      <h3 id="mail-personal-new-heading" className="text-[13px] font-semibold">Create personal mailbox</h3>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Authorized Mail administrators can provision their own or an employee&apos;s personal mailbox here.
        The owner receives exclusive personal-mailbox access; creating one never lets you read an employee&apos;s private messages.
        The action is audited and does not require a separate provisioning approval.
      </p>

      <form
        className="mt-3 grid gap-3 md:grid-cols-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!canSubmit || create.isPending) return;
          setCreated(null);
          create.mutate();
        }}
      >
        <fieldset className="flex flex-col gap-1 md:col-span-2">
          <legend className="mb-1 text-[11px] font-semibold">Who is this mailbox for?</legend>
          <div className="flex flex-wrap gap-4 text-[12px]">
            <label className="flex items-center gap-2">
              <input type="radio" name="personal-owner" value="SELF" checked={ownerMode === "SELF"} onChange={() => { setOwnerMode("SELF"); setCreated(null); }} />
              My account
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="personal-owner" value="STAFF" checked={ownerMode === "STAFF"} onChange={() => { setOwnerMode("STAFF"); setCreated(null); }} />
              An employee
            </label>
          </div>
        </fieldset>

        {ownerMode === "SELF" ? (
          <p className="text-[12px] md:col-span-2">
            Owner: <span className="font-semibold">{currentUser?.name || "Current administrator"}</span>
          </p>
        ) : (
          <div className="flex flex-col gap-1 md:col-span-2">
            <label className="text-[11px] font-semibold">Employee</label>
            {directoryForbidden ? (
              <p role="alert" className="text-[12px] text-muted-foreground">Staff directory permission is required.</p>
            ) : (
              <StaffPicker value={staff} onChange={setStaff} onForbidden={() => setDirectoryForbidden(true)} />
            )}
          </div>
        )}

        {existing && (
          <p role="status" className="text-[12px] md:col-span-2">
            {ownerMode === "SELF" ? "You already have a personal mailbox." : "This employee already has a personal mailbox."}
            {" "}Use Mail to access it rather than creating another.
          </p>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor="personal-mail-brand" className="text-[11px] font-semibold">Brand</label>
          <select
            id="personal-mail-brand"
            className={input}
            value={form.organizationId}
            onChange={(event) => setForm({ ...form, organizationId: event.target.value, domainId: "" })}
            required
          >
            <option value="">Select brand…</option>
            {(organizations.data ?? []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="personal-mail-name" className="text-[11px] font-semibold">Mailbox name (optional)</label>
          <input
            id="personal-mail-name"
            className={input}
            maxLength={160}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder={targetName || "Employee name"}
          />
        </div>
        <div className="flex flex-col gap-1 md:col-span-2">
          <label htmlFor="personal-mail-local-part" className="text-[11px] font-semibold">Email address</label>
          <div className="flex items-center gap-2">
            <input
              id="personal-mail-local-part"
              className={input}
              value={form.localPart}
              onChange={(event) => setForm({ ...form, localPart: event.target.value })}
              placeholder="yourname"
              aria-label="Personal email local part"
              autoCapitalize="none"
              autoComplete="off"
              required
            />
            <span aria-hidden="true">@</span>
            <select
              aria-label="Personal email domain"
              className={input}
              value={form.domainId}
              onChange={(event) => setForm({ ...form, domainId: event.target.value })}
              required
            >
              <option value="">Verified domain…</option>
              {availableDomains.map((domain) => <option key={domain.id} value={domain.id}>{domain.domain}</option>)}
            </select>
          </div>
          {form.organizationId && availableDomains.length === 0 && !domains.isLoading && (
            <p role="status" className="text-[11px] text-muted-foreground">
              Register and verify a domain under Domains before creating an email address.
            </p>
          )}
        </div>

        {create.error && <p role="alert" className="text-[12px] text-red-700 md:col-span-2">{classifyMailError(create.error).message}</p>}
        {created && (
          <p role="status" className="text-[12px] text-green-700 md:col-span-2">
            Mailbox created: {created}.{" "}
            {ownerMode === "SELF" ? <Link className="font-semibold underline" href="/dashboard/mail">Open your Mail inbox</Link> : "The employee can now sign in and open Mail."}
          </p>
        )}
        <div className="md:col-span-2">
          <button type="submit" className={button} disabled={!canSubmit || create.isPending}>
            {create.isPending ? "Creating…" : "Create personal mailbox"}
          </button>
        </div>
      </form>
    </section>
  );
}
