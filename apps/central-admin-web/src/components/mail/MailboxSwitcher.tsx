"use client";

import { useRouter } from "next/navigation";
import type { MailboxSummary } from "@/types/mail.types";

export default function MailboxSwitcher({
  mailboxes,
  currentId,
  onSwitch,
}: {
  mailboxes: MailboxSummary[];
  currentId: string;
  onSwitch?: () => void;
}) {
  const router = useRouter();
  if (mailboxes.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor="mailbox-switcher" className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Mailbox
      </label>
      <select
        id="mailbox-switcher"
        value={currentId}
        onChange={(e) => { router.push(`/dashboard/mail/${e.target.value}`); onSwitch?.(); }}
        className="w-full min-w-0 rounded-lg border border-border bg-card px-2.5 py-3 text-xs font-medium text-foreground focus:border-primary focus:ring-2 focus:ring-primary/10 outline-none"
      >
        {mailboxes.map((mb) => (
          <option key={mb.id} value={mb.id}>
            {mb.name}
            {mb.type === "SHARED" ? " (shared)" : ""}
            {mb.unreadCount > 0 ? ` · ${mb.unreadCount}` : ""}
          </option>
        ))}
      </select>
      <p className="truncate text-[10px] text-muted-foreground" title={mailboxes.find(m => m.id === currentId)?.primaryAddress ?? undefined}>{mailboxes.find(m => m.id === currentId)?.primaryAddress}</p>
    </div>
  );
}
