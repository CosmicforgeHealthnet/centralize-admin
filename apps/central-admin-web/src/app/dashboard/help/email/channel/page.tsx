"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import HelpSubNav from "@/components/help/HelpSubNav";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import SharedQueue from "@/components/mail/SharedQueue";
import { mailKeys, useMailbox } from "@/components/mail/hooks";
import { classifyMailError, updateMailboxSettings } from "@/lib/mail.service";

const inputClass =
  "w-full border border-border rounded-md px-4 py-2.5 text-[12px] text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors bg-card disabled:bg-muted disabled:text-muted-foreground";

const Toggle = ({ enabled, onToggle, disabled, label }: { enabled: boolean; onToggle: () => void; disabled?: boolean; label: string }) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    aria-label={label}
    disabled={disabled}
    onClick={onToggle}
    className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 disabled:opacity-50 ${enabled ? "bg-primary" : "bg-input"}`}
  >
    <span className={`absolute top-0.5 w-5 h-5 bg-primary-foreground rounded-full shadow transition-all duration-200 ${enabled ? "left-[22px]" : "left-0.5"}`} />
  </button>
);

function ChannelInner() {
  const params = useSearchParams();
  const mailboxId = params.get("mailboxId");
  const qc = useQueryClient();
  const mailboxQ = useMailbox(mailboxId);
  const mailbox = mailboxQ.data;
  const canManage = mailbox?.role === "OWNER" || mailbox?.role === "MANAGER";

  const [signature, setSignature] = useState("");
  const [sla, setSla] = useState<string>("");
  const [ticketLink, setTicketLink] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [seeded, setSeeded] = useState<typeof mailbox | null>(null);
  if (mailbox && seeded !== mailbox) {
    // Derived state: refresh the form when the server copy changes.
    setSeeded(mailbox);
    setSignature(mailbox.signatureHtml ?? "");
    setSla(mailbox.slaFirstResponseMinutes != null ? String(mailbox.slaFirstResponseMinutes) : "");
    setTicketLink(!!mailbox.supportTicketLinkEnabled);
  }

  const save = useMutation({
    mutationFn: () =>
      updateMailboxSettings(mailboxId as string, {
        signatureHtml: signature || null,
        slaFirstResponseMinutes: sla ? Number(sla) : null,
        supportTicketLinkEnabled: ticketLink,
      }),
    onSuccess: () => {
      setMsg("Channel settings saved.");
      qc.invalidateQueries({ queryKey: mailKeys.mailbox(mailboxId as string) });
    },
    onError: (e) => setMsg(classifyMailError(e).message),
  });

  if (!mailboxId) {
    return (
      <div role="alert" className="bg-card rounded-lg border border-border p-6 text-[12px] text-muted-foreground">
        No support channel selected. <Link href="/dashboard/help/email" className="text-primary underline">Choose a channel</Link>.
      </div>
    );
  }

  return (
    <PermissionBoundary
      isLoading={mailboxQ.isLoading}
      error={mailboxQ.error}
      retry={() => mailboxQ.refetch()}
      forbiddenMessage="You are not a member of this support mailbox."
    >
      {mailbox && (
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
          <div className="flex-1 min-w-0 bg-card rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="text-body-text font-bold text-primary">{mailbox.name}</h2>
                <p className="text-[11px] text-muted-foreground">{mailbox.primaryAddress ?? "No primary address"}</p>
              </div>
              <Link href={`/dashboard/mail/${mailbox.id}?view=queue`} className="text-[12px] font-semibold text-primary hover:underline">
                Open in Mail
              </Link>
            </div>
            <SharedQueue mailbox={mailbox} />
          </div>

          <form
            className="w-full xl:w-[340px] shrink-0 bg-card rounded-lg border border-border p-5 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setMsg(null);
              save.mutate();
            }}
            aria-labelledby="channel-settings-h"
          >
            <h3 id="channel-settings-h" className="text-[13px] font-semibold text-foreground">Channel settings</h3>
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground mb-1">Approved sender addresses</p>
              <ul className="text-[12px]">
                {mailbox.senderIdentities.length === 0 && <li className="text-muted-foreground">None configured.</li>}
                {mailbox.senderIdentities.map((s) => (
                  <li key={s.addressId}>{s.displayName ? `${s.displayName} <${s.address}>` : s.address}</li>
                ))}
              </ul>
            </div>
            <label className="flex flex-col gap-1 text-[12px] text-foreground">
              First-response SLA (minutes)
              <input
                type="number"
                min={1}
                max={10080}
                value={sla}
                disabled={!canManage}
                onChange={(e) => setSla(e.target.value)}
                className={inputClass}
                placeholder="No SLA"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-foreground">
              Shared signature
              <textarea rows={5} value={signature} disabled={!canManage} onChange={(e) => setSignature(e.target.value)} className={inputClass} />
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-foreground">Link conversations to support tickets</span>
              <Toggle enabled={ticketLink} disabled={!canManage} onToggle={() => setTicketLink((v) => !v)} label="Link conversations to support tickets" />
            </div>
            {canManage ? (
              <button type="submit" disabled={save.isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground text-[13px] font-semibold px-6 py-2.5 rounded-md disabled:opacity-50">
                {save.isPending ? "Saving…" : "Save settings"}
              </button>
            ) : (
              <p className="text-[11px] text-muted-foreground">Only mailbox managers can change channel settings.</p>
            )}
            {msg && <p role="status" className="text-[11px] text-muted-foreground">{msg}</p>}
          </form>
        </div>
      )}
    </PermissionBoundary>
  );
}

export default function SupportChannelPage() {
  return (
    <div className="flex gap-4">
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <HelpSubNav />
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="min-[1014px]:hidden">
          <HelpSubNav />
        </div>
        <Suspense fallback={null}>
          <ChannelInner />
        </Suspense>
      </div>
    </div>
  );
}
