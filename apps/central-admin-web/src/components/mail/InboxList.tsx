"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Loader2, MailOpen, Paperclip, Star, Trash2, Mail } from "lucide-react";
import PermissionBoundary from "./PermissionBoundary";
import { useDrafts, useSearch, useThreadActions, useThreads } from "./hooks";
import { STATUS_LABELS, formatMailDate, isTypingTarget, shortParty, statusTone } from "./mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import type { BulkAction, MailView, MailboxSummary, SearchParams, ThreadSummary } from "@/types/mail.types";

function ThreadRow({
  thread,
  href,
  selected,
  checked,
  onCheck,
  showStatus,
}: {
  thread: ThreadSummary;
  href: string;
  selected: boolean;
  checked: boolean;
  onCheck: (v: boolean) => void;
  showStatus: boolean;
}) {
  const names = thread.participants.slice(0, 3).map(shortParty).join(", ") || "(no participants)";
  return (
    <li
      className={`group flex items-start gap-3 border-b border-border px-3 py-3 transition-colors ${selected ? "bg-primary/10" : thread.isRead ? "bg-card" : "bg-primary/[0.03]"} hover:bg-muted/60`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
        aria-label={`Select conversation ${thread.subject || "(no subject)"}`}
        className="mt-1 h-4 w-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      />
      <Link href={href} aria-current={selected ? "true" : undefined} className="min-w-0 flex-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" data-thread-link={thread.id}>
        <div className="flex items-center gap-2">
          <span className={`truncate text-sm ${thread.isRead ? "text-foreground" : "font-semibold text-foreground"}`}>{names}</span>
          {thread.messageCount > 1 && <span className="text-xs text-muted-foreground">{thread.messageCount}</span>}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatMailDate(thread.lastMessageAt)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {thread.isStarred && <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-label="Starred" />}
          {thread.hasAttachments && <Paperclip className="h-3 w-3 text-muted-foreground" aria-label="Has attachments" />}
          <span className={`truncate text-[13px] ${thread.isRead ? "text-foreground" : "font-semibold text-foreground"}`}>
            {thread.subject || "(no subject)"}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs leading-5 text-muted-foreground">{thread.snippet}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {thread.labels.map((l) => (
            <span key={l.id} className="rounded border border-border px-1 text-[10px] text-muted-foreground" style={{ borderColor: l.color ?? undefined }}>
              {l.name}
            </span>
          ))}
          {thread.conversationStatus && (
            <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{thread.conversationStatus}</span>
          )}
          {showStatus && thread.lastDeliveryStatus && thread.lastDeliveryStatus !== "RECEIVED" && (
            <span className={`rounded border px-1 text-[10px] ${statusTone(thread.lastDeliveryStatus)}`}>
              {STATUS_LABELS[thread.lastDeliveryStatus]}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

export default function InboxList({
  mailbox,
  view,
  labelId,
  search,
  selectedThreadId,
}: {
  mailbox: MailboxSummary;
  view: MailView;
  labelId?: string;
  search: SearchParams | null;
  selectedThreadId?: string;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const isDrafts = view === "drafts" && !search;
  const threadView = (view === "drafts" ? "inbox" : view) as Exclude<MailView, "drafts">;
  const threadsQ = useThreads(mailbox.id, threadView, labelId, !isDrafts && !search);
  const searchQ = useSearch(mailbox.id, search ?? {}, !!search);
  const draftsQ = useDrafts(mailbox.id, isDrafts);
  const { bulk } = useThreadActions(mailbox.id);

  const active = search ? searchQ : threadsQ;
  const threads = useMemo(() => (active.data?.pages ?? []).flatMap((p) => p.items), [active.data]);
  const base = `/dashboard/mail/${mailbox.id}`;
  const qs = search ? "" : `?view=${view}${labelId ? `&labelId=${labelId}` : ""}`;

  // Reset the selection when the list scope changes (derived state).
  const scope = `${mailbox.id}|${view}|${labelId ?? ""}`;
  const [checkedScope, setCheckedScope] = useState(scope);
  if (checkedScope !== scope) {
    setCheckedScope(scope);
    setChecked(new Set());
  }

  // j / k navigation across the visible list.
  useEffect(() => {
    if (isDrafts) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "j" && e.key !== "k") return;
      if (threads.length === 0) return;
      const idx = threads.findIndex((t) => t.id === selectedThreadId);
      const next = e.key === "j" ? Math.min(idx + 1, threads.length - 1) : Math.max(idx - 1, 0);
      const target = threads[idx === -1 ? 0 : next];
      if (target) {
        e.preventDefault();
        router.push(`${base}/thread/${target.id}${qs}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [threads, selectedThreadId, router, base, qs, isDrafts]);

  const runBulk = async (action: BulkAction) => {
    const ids = [...checked];
    if (!ids.length) return;
    setNotice(null);
    try {
      const res = await bulk.mutateAsync({ threadIds: ids, action });
      setNotice(`${res.updated} conversation${res.updated === 1 ? "" : "s"} updated.`);
      setChecked(new Set());
    } catch (err) {
      setNotice(classifyMailError(err).message);
    }
  };

  if (isDrafts) {
    return (
      <PermissionBoundary isLoading={draftsQ.isLoading} error={draftsQ.error} retry={() => draftsQ.refetch()} loadingLabel="Loading drafts">
        {(draftsQ.data?.items ?? []).length === 0 ? (
          <p role="status" className="p-6 text-center text-[12px] text-muted-foreground">No drafts.</p>
        ) : (
          <ul aria-label="Drafts">
            {(draftsQ.data?.items ?? []).map((d) => (
              <li key={d.id} className="border-b border-border">
                <Link
                  href={`/dashboard/mail/compose?mailboxId=${mailbox.id}&draftId=${d.id}`}
                  className="block px-3 py-2.5 hover:bg-muted/60"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[12px] font-semibold text-red-600">Draft</span>
                    <span className="truncate text-[12px]">{d.to.map(shortParty).join(", ") || "(no recipients)"}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{formatMailDate(d.updatedAt)}</span>
                  </div>
                  <p className="truncate text-[12px] text-muted-foreground">{d.subject || "(no subject)"}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PermissionBoundary>
    );
  }

  const allChecked = threads.length > 0 && threads.every((t) => checked.has(t.id));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          <input
          type="checkbox"
          aria-label="Select all conversations"
          checked={allChecked}
          onChange={(e) => setChecked(e.target.checked ? new Set(threads.map((t) => t.id)) : new Set())}
            className="h-4 w-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        />
        <div className="ml-2 flex items-center gap-1" role="toolbar" aria-label="Bulk actions">
          {[
            { a: "archive" as const, icon: Archive, label: "Archive selected" },
            { a: "trash" as const, icon: Trash2, label: "Move selected to trash" },
            { a: "read" as const, icon: MailOpen, label: "Mark selected read" },
            { a: "unread" as const, icon: Mail, label: "Mark selected unread" },
          ].map(({ a, icon: Icon, label }) => (
            <button
              key={a}
              type="button"
              disabled={checked.size === 0 || bulk.isPending}
              onClick={() => runBulk(a)}
              title={label}
              aria-label={label}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
        {bulk.isPending && <Loader2 className="ml-1 h-4 w-4 animate-spin text-muted-foreground" aria-label="Updating" />}
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {search ? "Search results" : checked.size ? `${checked.size} selected` : ""}
        </span>
      </div>
      {notice && (
        <p role="status" className="border-b border-border bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PermissionBoundary isLoading={active.isLoading} error={active.error} retry={() => active.refetch()} loadingLabel="Loading conversations">
          {threads.length === 0 ? (
            <p role="status" className="p-6 text-center text-[12px] text-muted-foreground">
              {search ? "No conversations match your search." : "No conversations here."}
            </p>
          ) : (
            <ul aria-label="Conversations">
              {threads.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  href={`${base}/thread/${t.id}${qs}`}
                  selected={t.id === selectedThreadId}
                  checked={checked.has(t.id)}
                  showStatus={view === "sent"}
                  onCheck={(v) =>
                    setChecked((prev) => {
                      const next = new Set(prev);
                      if (v) next.add(t.id);
                      else next.delete(t.id);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          )}
          {active.hasNextPage && (
            <div className="p-3 text-center">
              <button
                type="button"
                onClick={() => active.fetchNextPage()}
                disabled={active.isFetchingNextPage}
                className="rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-muted disabled:opacity-50"
              >
                {active.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </PermissionBoundary>
      </div>
    </div>
  );
}
