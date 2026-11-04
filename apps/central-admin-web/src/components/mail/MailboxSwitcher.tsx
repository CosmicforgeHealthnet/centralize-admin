"use client";

import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import type { MailboxSummary } from "@/types/mail.types";

export default function MailboxSwitcher({ mailboxes, currentId, onSwitch }: {
  mailboxes: MailboxSummary[];
  currentId: string;
  onSwitch?: () => void;
}) {
  const router = useRouter();
  if (mailboxes.length === 0) return null;
  const current = mailboxes.find(mailbox => mailbox.id === currentId) ?? mailboxes[0];
  const canSwitch = mailboxes.length > 1;

  return (
    <div className={`relative min-w-0 rounded-lg px-3 py-2.5 ${canSwitch ? "transition-colors hover:bg-muted/60 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary" : ""}`}>
      <div className="pointer-events-none flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-5 text-foreground" title={current.name}>{current.name}</p>
          <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground" title={current.primaryAddress}>{current.primaryAddress}</p>
        </div>
        {canSwitch && <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.7} aria-hidden="true" />}
      </div>
      {canSwitch && <>
        <label htmlFor="mailbox-switcher" className="sr-only">Mailbox</label>
        <select id="mailbox-switcher" value={current.id} onChange={event => { router.push(`/dashboard/mail/${event.target.value}`); onSwitch?.(); }} className="absolute inset-0 h-full w-full cursor-pointer rounded-lg text-base opacity-0" title="Switch mailbox">
          {mailboxes.map(mailbox => <option key={mailbox.id} value={mailbox.id}>{mailbox.name} ({mailbox.primaryAddress}){mailbox.type === "SHARED" ? " - shared" : ""}</option>)}
        </select>
      </>}
    </div>
  );
}
