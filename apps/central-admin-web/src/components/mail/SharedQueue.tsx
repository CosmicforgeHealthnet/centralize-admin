"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Link2, Lock, MessageSquareText, Unlock, UserRound } from "lucide-react";
import PermissionBoundary from "./PermissionBoundary";
import { mailKeys, useMembers, useQueue } from "./hooks";
import { formatFullDate, formatMailDate, shortParty } from "./mail-utils";
import { useAuthStore } from "@/stores/auth.store";
import {
  addNote,
  assignThread,
  classifyMailError,
  fetchActivity,
  fetchNotes,
  lockThread,
  setThreadStatus,
  setTicketLink,
  unlockThread,
} from "@/lib/mail.service";
import type { ConversationStatus, MailboxSummary, ThreadSummary } from "@/types/mail.types";

const STATUSES: ConversationStatus[] = ["OPEN", "PENDING", "RESOLVED", "CLOSED"];

function slaLabel(thread: ThreadSummary): { text: string; tone: string } | null {
  if (!thread.slaDueAt || thread.conversationStatus === "RESOLVED" || thread.conversationStatus === "CLOSED") return null;
  const due = new Date(thread.slaDueAt).getTime();
  const mins = Math.round((due - Date.now()) / 60000);
  if (mins < 0) return { text: `SLA breached ${Math.abs(mins)}m ago`, tone: "text-red-600" };
  if (mins < 60) return { text: `SLA due in ${mins}m`, tone: "text-amber-600" };
  return { text: `SLA due ${formatMailDate(thread.slaDueAt)}`, tone: "text-muted-foreground" };
}

function lockHolder(thread: ThreadSummary, meId?: string) {
  if (!thread.lockedBy || !thread.lockExpiresAt) return null;
  if (new Date(thread.lockExpiresAt).getTime() < Date.now()) return null;
  if (thread.lockedBy.id === meId) return null;
  return thread.lockedBy;
}

/** Assignment, status, collision lock, notes and ticket link for a shared conversation. */
export function ConversationPanel({ mailbox, thread }: { mailbox: MailboxSummary; thread: ThreadSummary }) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const canEdit = mailbox.role !== "READER";
  const members = useMembers(mailbox.id, canEdit);
  const notesQ = useQuery({ queryKey: mailKeys.notes(thread.id), queryFn: () => fetchNotes(thread.id), gcTime: 5 * 60 * 1000 });
  const activityQ = useQuery({ queryKey: mailKeys.activity(thread.id), queryFn: () => fetchActivity(thread.id), gcTime: 5 * 60 * 1000, enabled: false });
  const [note, setNote] = useState("");
  const [ticket, setTicket] = useState(thread.supportTicketRef ?? "");
  const [error, setError] = useState<string | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [myLock, setMyLock] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: mailKeys.thread(thread.id) });
    qc.invalidateQueries({ queryKey: ["mail", "mailbox", mailbox.id] });
  };
  const onErr = (err: unknown) => {
    const info = classifyMailError(err);
    if (info.code === "MAIL_CONVERSATION_LOCKED") {
      const by = info.detail?.lockedBy as { name?: string } | string | undefined;
      setError(`${typeof by === "string" ? by : by?.name ?? "Another agent"} is replying to this conversation.`);
    } else if (info.code === "MAIL_INVALID_TRANSITION" || info.kind === "conflict") {
      setError("This conversation changed since you loaded it. It has been refreshed; try again.");
      refresh();
    } else setError(info.message);
  };

  const assign = useMutation({ mutationFn: (id: string | null) => assignThread(thread.id, id), onSuccess: refresh, onError: onErr });
  const status = useMutation({
    mutationFn: (s: ConversationStatus) => setThreadStatus(thread.id, s, thread.revision),
    onSuccess: refresh,
    onError: onErr,
  });
  const lock = useMutation({
    mutationFn: () => lockThread(thread.id),
    onSuccess: (r) => {
      setMyLock(r.lockExpiresAt);
      refresh();
    },
    onError: onErr,
  });
  const unlock = useMutation({
    mutationFn: () => unlockThread(thread.id),
    onSuccess: () => {
      setMyLock(null);
      refresh();
    },
    onError: onErr,
  });
  const addNoteM = useMutation({
    mutationFn: () => addNote(thread.id, note.trim()),
    onSuccess: () => {
      setNote("");
      qc.invalidateQueries({ queryKey: mailKeys.notes(thread.id) });
    },
    onError: onErr,
  });
  const ticketM = useMutation({ mutationFn: () => setTicketLink(thread.id, ticket.trim() || null), onSuccess: refresh, onError: onErr });

  const holder = lockHolder(thread, me?.id);
  const sla = slaLabel(thread);

  return (
    <section aria-label="Shared conversation" className="mb-3 rounded-lg border border-border bg-muted/30 p-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5">
          <UserRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Assignee</span>
          <select
            value={thread.assignedTo?.id ?? ""}
            disabled={!canEdit || assign.isPending}
            onChange={(e) => assign.mutate(e.target.value || null)}
            className="rounded border border-border bg-card px-2 py-1 text-[12px]"
            aria-label="Assign conversation"
          >
            <option value="">Unassigned</option>
            {thread.assignedTo && !(members.data ?? []).some((m) => m.adminUserId === thread.assignedTo?.id) && (
              <option value={thread.assignedTo.id}>{thread.assignedTo.name}</option>
            )}
            {(members.data ?? []).map((m) => (
              <option key={m.id} value={m.adminUserId}>
                {m.name || m.email || m.adminUserId}
                {m.adminUserId === me?.id ? " (me)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Status</span>
          <select
            value={thread.conversationStatus ?? "OPEN"}
            disabled={!canEdit || status.isPending}
            onChange={(e) => status.mutate(e.target.value as ConversationStatus)}
            className="rounded border border-border bg-card px-2 py-1 text-[12px]"
            aria-label="Conversation status"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        {sla && (
          <span className={`flex items-center gap-1 ${sla.tone}`}>
            <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {sla.text}
          </span>
        )}
        {canEdit && (
          <span className="ml-auto">
            {holder ? (
              <span role="status" className="flex items-center gap-1 text-amber-700">
                <Lock className="h-3.5 w-3.5" aria-hidden="true" /> {holder.name} is replying
              </span>
            ) : myLock ? (
              <button type="button" onClick={() => unlock.mutate()} className="flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-muted">
                <Unlock className="h-3.5 w-3.5" /> Release reply lock
              </button>
            ) : (
              <button type="button" onClick={() => lock.mutate()} disabled={lock.isPending} className="flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-muted">
                <Lock className="h-3.5 w-3.5" /> I&apos;m replying
              </button>
            )}
          </span>
        )}
      </div>

      {mailbox.purpose === "SUPPORT" && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ticketM.mutate();
          }}
        >
          <Link2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <label htmlFor={`ticket-${thread.id}`} className="text-muted-foreground">Ticket</label>
          <input
            id={`ticket-${thread.id}`}
            value={ticket}
            disabled={!canEdit}
            onChange={(e) => setTicket(e.target.value)}
            placeholder="Ticket reference"
            maxLength={128}
            className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1"
          />
          {canEdit && (
            <button type="submit" disabled={ticketM.isPending} className="rounded border border-border px-2 py-1 font-semibold hover:bg-muted">
              Save
            </button>
          )}
          {thread.supportTicketRef && (
            <Link href={`/dashboard/help/tickets?ref=${encodeURIComponent(thread.supportTicketRef)}`} className="text-primary underline">
              Open ticket
            </Link>
          )}
        </form>
      )}

      {error && <p role="alert" className="mt-2 text-red-600">{error}</p>}

      <div className="mt-3">
        <h3 className="mb-1 flex items-center gap-1 font-semibold text-foreground">
          <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" /> Internal notes
          <span className="font-normal text-muted-foreground">(never sent to the customer)</span>
        </h3>
        <PermissionBoundary isLoading={notesQ.isLoading} error={notesQ.error} compact loadingLabel="Loading notes">
          {(notesQ.data ?? []).length === 0 ? (
            <p className="text-muted-foreground">No internal notes.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {(notesQ.data ?? []).map((n) => (
                <li key={n.id} className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
                  <p className="whitespace-pre-wrap text-foreground">{n.body}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {n.author?.name ?? "Unknown"} · {formatFullDate(n.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </PermissionBoundary>
        {canEdit && (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) addNoteM.mutate();
            }}
          >
            <label htmlFor={`note-${thread.id}`} className="sr-only">Add internal note</label>
            <textarea
              id={`note-${thread.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={5000}
              placeholder="Add an internal note"
              className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1"
            />
            <button type="submit" disabled={!note.trim() || addNoteM.isPending} className="self-end rounded bg-primary px-3 py-1.5 font-semibold text-primary-foreground disabled:opacity-50">
              Add note
            </button>
          </form>
        )}
      </div>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => {
            setShowActivity((s) => !s);
            if (!activityQ.data) activityQ.refetch();
          }}
          aria-expanded={showActivity}
          className="font-semibold text-primary hover:underline"
        >
          {showActivity ? "Hide activity" : "Show activity"}
        </button>
        {showActivity && (
          <PermissionBoundary isLoading={activityQ.isFetching && !activityQ.data} error={activityQ.error} compact>
            <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
              {(activityQ.data ?? []).length === 0 && <li>No recorded activity.</li>}
              {(activityQ.data ?? []).map((a) => (
                <li key={a.id}>
                  {formatFullDate(a.createdAt)} · {a.actor?.name ?? "System"} · {a.action}
                </li>
              ))}
            </ul>
          </PermissionBoundary>
        )}
      </div>
    </section>
  );
}

/** Shared mailbox work queue (Support and other shared inboxes). */
export default function SharedQueue({ mailbox, compactLinks }: { mailbox: MailboxSummary; compactLinks?: boolean }) {
  const me = useAuthStore((s) => s.user);
  const [status, setStatus] = useState<string>("OPEN");
  const [assignee, setAssignee] = useState<string>("");
  const q = useQueue(mailbox.id, status, assignee);
  const threads = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-[12px]">
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded border border-border bg-card px-2 py-1">
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">Assignee</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="rounded border border-border bg-card px-2 py-1">
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </label>
      </div>
      <PermissionBoundary
        isLoading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        loadingLabel="Loading queue"
        forbiddenMessage="You are not a member of this shared mailbox."
      >
        {threads.length === 0 ? (
          <p role="status" className="p-6 text-center text-[12px] text-muted-foreground">No conversations in this queue.</p>
        ) : (
          <ul aria-label={`${mailbox.name} queue`}>
            {threads.map((t) => {
              const sla = slaLabel(t);
              const holder = lockHolder(t, me?.id);
              return (
                <li key={t.id} className="border-b border-border">
                  <Link
                    href={`/dashboard/mail/${mailbox.id}/thread/${t.id}?view=queue`}
                    className="flex flex-col gap-0.5 px-3 py-2.5 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`truncate text-[12px] ${t.isRead ? "" : "font-semibold"}`}>
                        {t.participants.map(shortParty).slice(0, 2).join(", ")}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{formatMailDate(t.lastMessageAt)}</span>
                    </div>
                    <span className="truncate text-[12px] text-foreground">{t.subject || "(no subject)"}</span>
                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="rounded bg-muted px-1">{t.conversationStatus ?? "OPEN"}</span>
                      <span>{t.assignedTo ? `Assigned to ${t.assignedTo.id === me?.id ? "me" : t.assignedTo.name}` : "Unassigned"}</span>
                      {sla && <span className={sla.tone}>{sla.text}</span>}
                      {holder && <span className="text-amber-700">{holder.name} is replying</span>}
                      {!compactLinks && t.supportTicketRef && <span>Ticket {t.supportTicketRef}</span>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {q.hasNextPage && (
          <div className="p-3 text-center">
            <button type="button" onClick={() => q.fetchNextPage()} className="rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-muted">
              Load more
            </button>
          </div>
        )}
      </PermissionBoundary>
    </div>
  );
}
