"use client";

import { useRouter } from "next/navigation";
import type { MailboxSummary } from "@/types/mail.types";

export default function MailboxSwitcher({
  mailboxes,
  currentId,
}: {
  mailboxes: MailboxSummary[];
  currentId: string;
}) {
  const router = useRouter();
  if (mailboxes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="mailbox-switcher" className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Mailbox
      </label>
      <select
        id="mailbox-switcher"
        value={currentId}
        onChange={(e) => router.push(`/dashboard/mail/${e.target.value}`)}
        className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-[12px] text-foreground focus:border-primary outline-none"
      >
        {mailboxes.map((mb) => (
          <option key={mb.id} value={mb.id}>
            {mb.name}
            {mb.type === "SHARED" ? " (shared)" : ""}
            {mb.unreadCount > 0 ? ` · ${mb.unreadCount}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
