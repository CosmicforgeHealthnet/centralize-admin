"use client";

import Link from "next/link";
import {
  Archive,
  File,
  Inbox,
  MailOpen,
  PenSquare,
  Send,
  Settings,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import MailboxSwitcher from "./MailboxSwitcher";
import { MAIL_VIEWS } from "./mail-utils";
import { useLabels } from "./hooks";
import type { MailView, MailboxSummary } from "@/types/mail.types";

const VIEW_ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  starred: Star,
  unread: MailOpen,
  sent: Send,
  drafts: File,
  archive: Archive,
  spam: ShieldAlert,
  trash: Trash2,
};

export default function MailSidebar({
  mailboxes,
  mailbox,
  view,
  labelId,
  queueActive,
  sendingEnabled,
  onMailboxChange,
}: {
  mailboxes: MailboxSummary[];
  mailbox: MailboxSummary;
  view: MailView;
  labelId?: string;
  queueActive?: boolean;
  sendingEnabled: boolean;
  onMailboxChange?: () => void;
}) {
  const labels = useLabels(mailbox.id);
  const canCompose = mailbox.canSend && mailbox.status === "ACTIVE";
  const base = `/dashboard/mail/${mailbox.id}`;

  return (
    <nav aria-label="Mail folders" className="flex flex-col gap-4 p-3">
      <MailboxSwitcher mailboxes={mailboxes} currentId={mailbox.id} onSwitch={onMailboxChange} />
      {canCompose ? (
        <Link
          href={`/dashboard/mail/compose?mailboxId=${mailbox.id}`}
          className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90"
          title={sendingEnabled ? "Compose (c)" : "Sending is disabled; drafts can still be saved"}
        >
          <PenSquare className="h-4 w-4" aria-hidden="true" /> Compose
        </Link>
      ) : (
        <p className="rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground">
          {mailbox.status !== "ACTIVE" ? `Mailbox is ${mailbox.status.toLowerCase()}.` : "Read-only access to this mailbox."}
        </p>
      )}
      <ul className="flex flex-col gap-0.5">
        {mailbox.type === "SHARED" && (
          <li>
            <Link
              href={`${base}?view=queue`}
              aria-current={queueActive ? "page" : undefined}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${queueActive ? "bg-primary/10 font-semibold text-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              <Users className="h-4 w-4" aria-hidden="true" /> Shared queue
            </Link>
          </li>
        )}
        {MAIL_VIEWS.map((v) => {
          const Icon = VIEW_ICONS[v.id] ?? Inbox;
          const active = !queueActive && !labelId && view === v.id;
          return (
            <li key={v.id}>
              <Link
                href={`${base}?view=${v.id}`}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${active ? "bg-primary/10 font-semibold text-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span className="flex-1">{v.label}</span>
                {v.id === "inbox" && mailbox.unreadCount > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground" aria-label={`${mailbox.unreadCount} unread`}>
                    {mailbox.unreadCount}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <div>
        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Labels</p>
        {labels.isError ? (
          <p className="px-2 text-[11px] text-muted-foreground">Labels unavailable.</p>
        ) : (labels.data ?? []).length === 0 ? (
          <p className="px-2 text-[11px] text-muted-foreground">{labels.isLoading ? "Loading…" : "No labels yet."}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {(labels.data ?? []).map((l) => (
              <li key={l.id}>
                <Link
                  href={`${base}?view=all&labelId=${l.id}`}
                  aria-current={labelId === l.id ? "page" : undefined}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${labelId === l.id ? "bg-primary/10 font-semibold" : "text-muted-foreground hover:bg-muted"}`}
                >
                  <Tag className="h-3.5 w-3.5" style={{ color: l.color ?? undefined }} aria-hidden="true" />
                  {l.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Link
        href={`/dashboard/mail/settings?mailboxId=${mailbox.id}`}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-muted"
      >
        <Settings className="h-4 w-4" aria-hidden="true" /> Mailbox settings
      </Link>
    </nav>
  );
}
