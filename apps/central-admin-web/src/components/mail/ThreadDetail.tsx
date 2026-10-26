"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Forward,
  ImageOff,
  Inbox,
  Mail,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import MessageCard from "./MessageCard";
import ComposeEditor from "./ComposeEditor";
import PermissionBoundary from "./PermissionBoundary";
import { ConversationPanel } from "./SharedQueue";
import { mailKeys, useLabels, useThread, useThreadActions, useThreadMessages, usePurgeOnForbidden } from "./hooks";
import { isTypingTarget } from "./mail-utils";
import { addThreadLabel, classifyMailError, removeThreadLabel } from "@/lib/mail.service";
import type { DraftMode, MailboxSummary, ThreadFolder } from "@/types/mail.types";

export default function ThreadDetail({
  mailbox,
  threadId,
  backHref,
}: {
  mailbox: MailboxSummary;
  threadId: string;
  backHref: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [remoteImages, setRemoteImages] = useState<"block" | "allow">("block");
  const [compose, setCompose] = useState<{ mode: DraftMode; messageId: string } | null>(null);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const threadQ = useThread(threadId);
  const messagesQ = useThreadMessages(threadId, remoteImages);
  const labelsQ = useLabels(mailbox.id);
  const { move, state } = useThreadActions(mailbox.id);
  const markedRef = useRef<string | null>(null);
  usePurgeOnForbidden(threadQ.error || messagesQ.error, mailbox.id);

  const thread = threadQ.data;
  const messages = messagesQ.data ?? [];
  const last = messages[messages.length - 1];
  const canReply = mailbox.canSend && mailbox.status === "ACTIVE";

  useEffect(() => {
    setCompose(null);
    setRemoteImages("block");
    setNotice(null);
  }, [threadId]);

  // Opening a conversation marks it read for this user only.
  useEffect(() => {
    if (thread && !thread.isRead && markedRef.current !== thread.id) {
      markedRef.current = thread.id;
      state.mutate({ threadId: thread.id, isRead: true });
    }
  }, [thread, state]);

  const doMove = async (folder: ThreadFolder) => {
    setNotice(null);
    try {
      await move.mutateAsync({ threadId, folder });
      router.push(backHref);
    } catch (err) {
      setNotice(classifyMailError(err).message);
    }
  };

  const labelMutation = useMutation({
    mutationFn: ({ labelId, add }: { labelId: string; add: boolean }) =>
      add ? addThreadLabel(threadId, labelId) : removeThreadLabel(threadId, labelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.thread(threadId) });
      qc.invalidateQueries({ queryKey: ["mail", "mailbox", mailbox.id] });
    },
    onError: (err) => setNotice(classifyMailError(err).message),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || compose) return;
      if (e.key === "e") {
        e.preventDefault();
        doMove("ARCHIVE");
      } else if (e.key === "#") {
        e.preventDefault();
        doMove("TRASH");
      } else if (e.key === "r" && canReply && last) {
        e.preventDefault();
        setCompose({ mode: "REPLY", messageId: last.id });
      } else if (e.key === "Escape") {
        router.push(backHref);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose, canReply, last, backHref]);

  const blockedCount = messages.reduce((n, m) => n + (m.remoteImagesBlocked || 0), 0);
  const actionBtn = "rounded p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40";

  return (
    <PermissionBoundary
      isLoading={threadQ.isLoading}
      error={threadQ.error}
      retry={() => threadQ.refetch()}
      loadingLabel="Loading conversation"
    >
      {thread && (
        <div className="flex h-full flex-col">
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2" role="toolbar" aria-label="Conversation actions">
            <Link href={backHref} aria-label="Back to list" className={`${actionBtn} lg:hidden`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
            {thread.folder !== "ARCHIVE" && (
              <button type="button" onClick={() => doMove("ARCHIVE")} aria-label="Archive (e)" title="Archive (e)" className={actionBtn}>
                <Archive className="h-4 w-4" />
              </button>
            )}
            {thread.folder !== "INBOX" && (
              <button type="button" onClick={() => doMove("INBOX")} aria-label="Move to inbox" title="Move to inbox" className={actionBtn}>
                <Inbox className="h-4 w-4" />
              </button>
            )}
            {thread.folder !== "SPAM" && (
              <button type="button" onClick={() => doMove("SPAM")} aria-label="Report spam" title="Report spam" className={actionBtn}>
                <ShieldAlert className="h-4 w-4" />
              </button>
            )}
            {thread.folder !== "TRASH" && (
              <button type="button" onClick={() => doMove("TRASH")} aria-label="Move to trash (#)" title="Move to trash (#)" className={actionBtn}>
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => state.mutate({ threadId, isRead: false })}
              aria-label="Mark unread"
              title="Mark unread"
              className={actionBtn}
            >
              <Mail className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => state.mutate({ threadId, isStarred: !thread.isStarred })}
              aria-label={thread.isStarred ? "Unstar" : "Star"}
              aria-pressed={thread.isStarred}
              className={actionBtn}
            >
              <Star className={`h-4 w-4 ${thread.isStarred ? "fill-amber-400 text-amber-400" : ""}`} />
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setLabelsOpen((o) => !o)}
                aria-expanded={labelsOpen}
                aria-haspopup="true"
                aria-label="Labels"
                className={actionBtn}
              >
                <Tag className="h-4 w-4" />
              </button>
              {labelsOpen && (
                <div className="absolute left-0 z-20 mt-1 w-52 rounded-md border border-border bg-card p-2 shadow-lg">
                  {(labelsQ.data ?? []).length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      No labels. Create them in <Link className="text-primary underline" href={`/dashboard/mail/settings?mailboxId=${mailbox.id}`}>settings</Link>.
                    </p>
                  ) : (
                    (labelsQ.data ?? []).map((l) => {
                      const on = thread.labels.some((x) => x.id === l.id);
                      return (
                        <label key={l.id} className="flex items-center gap-2 py-0.5 text-[12px]">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={labelMutation.isPending}
                            onChange={() => labelMutation.mutate({ labelId: l.id, add: !on })}
                          />
                          {l.name}
                        </label>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <h1 className="mb-1 text-[16px] font-semibold text-foreground">{thread.subject || "(no subject)"}</h1>
            <div className="mb-3 flex flex-wrap gap-1">
              {thread.labels.map((l) => (
                <span key={l.id} className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">{l.name}</span>
              ))}
            </div>
            {notice && <p role="alert" className="mb-2 text-[12px] text-red-600">{notice}</p>}

            {mailbox.type === "SHARED" && <ConversationPanel key={thread.id} mailbox={mailbox} thread={thread} />}

            {blockedCount > 0 && remoteImages === "block" && (
              <div role="status" className="mb-3 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
                <ImageOff className="h-4 w-4" aria-hidden="true" />
                {blockedCount} remote image{blockedCount === 1 ? " was" : "s were"} blocked to protect your privacy.
                <button type="button" onClick={() => setRemoteImages("allow")} className="ml-auto font-semibold text-primary hover:underline">
                  Show images
                </button>
              </div>
            )}

            <PermissionBoundary isLoading={messagesQ.isLoading} error={messagesQ.error} retry={() => messagesQ.refetch()} loadingLabel="Loading messages" compact>
              <div className="flex flex-col gap-2">
                {messages.map((m, i) => (
                  <MessageCard key={m.id} message={m} allowRemoteImages={remoteImages === "allow"} defaultExpanded={i === messages.length - 1 || !thread.isRead} />
                ))}
              </div>
            </PermissionBoundary>

            {compose ? (
              <div className="mt-3">
                <ComposeEditor
                  inline
                  mailboxId={mailbox.id}
                  mode={compose.mode}
                  threadId={threadId}
                  inReplyToMessageId={compose.messageId}
                  onClose={() => setCompose(null)}
                  onSent={() => {
                    qc.invalidateQueries({ queryKey: ["mail", "thread", threadId] });
                  }}
                />
              </div>
            ) : (
              canReply &&
              last && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    { mode: "REPLY" as const, icon: Reply, label: "Reply (r)" },
                    { mode: "REPLY_ALL" as const, icon: ReplyAll, label: "Reply all" },
                    { mode: "FORWARD" as const, icon: Forward, label: "Forward" },
                  ].map(({ mode, icon: Icon, label }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setCompose({ mode, messageId: last.id })}
                      className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted"
                    >
                      <Icon className="h-3.5 w-3.5" /> {label}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      )}
    </PermissionBoundary>
  );
}
