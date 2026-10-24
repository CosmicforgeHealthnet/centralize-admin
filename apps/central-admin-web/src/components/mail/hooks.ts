"use client";

import { useEffect } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import * as mail from "@/lib/mail.service";
import type { BulkAction, MailView, SearchParams, ThreadFolder } from "@/types/mail.types";

// Mail content stays in memory only and is dropped quickly once unused.
const MAIL_GC_TIME = 5 * 60 * 1000;

function shouldRetry(failureCount: number, error: unknown) {
  const info = mail.classifyMailError(error);
  if (info.kind === "network" || (info.kind === "other" && (info.status ?? 500) >= 500)) return failureCount < 2;
  return false;
}

export const mailKeys = {
  all: ["mail"] as const,
  entitlements: ["mail", "entitlements"] as const,
  mailbox: (id: string) => ["mail", "mailbox", id] as const,
  threads: (id: string, view: string, labelId?: string) => ["mail", "mailbox", id, "threads", view, labelId ?? ""] as const,
  search: (id: string | null, params: SearchParams) => ["mail", "search", id ?? "*", params] as const,
  drafts: (id: string) => ["mail", "mailbox", id, "drafts"] as const,
  labels: (id: string) => ["mail", "mailbox", id, "labels"] as const,
  thread: (id: string) => ["mail", "thread", id] as const,
  messages: (id: string, remote: string) => ["mail", "thread", id, "messages", remote] as const,
  queue: (id: string, status: string, assignee: string) => ["mail", "mailbox", id, "queue", status, assignee] as const,
  notes: (id: string) => ["mail", "thread", id, "notes"] as const,
  activity: (id: string) => ["mail", "thread", id, "activity"] as const,
  members: (id: string) => ["mail", "mailbox", id, "members"] as const,
  support: ["mail", "support-mailboxes"] as const,
};

/** Drops cached content for a mailbox (e.g. after access is revoked). */
export function purgeMailbox(qc: QueryClient, mailboxId: string) {
  qc.removeQueries({ queryKey: ["mail", "mailbox", mailboxId] });
  qc.removeQueries({ queryKey: ["mail", "thread"] });
  qc.invalidateQueries({ queryKey: mailKeys.entitlements });
}

/** Watches an error and purges cached mailbox data on 401/403. */
export function usePurgeOnForbidden(error: unknown, mailboxId: string | null | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!error || !mailboxId) return;
    const info = mail.classifyMailError(error);
    if (info.kind === "forbidden" || info.status === 401) purgeMailbox(qc, mailboxId);
  }, [error, mailboxId, qc]);
}

export function useEntitlements() {
  return useQuery({
    queryKey: mailKeys.entitlements,
    queryFn: mail.fetchEntitlements,
    gcTime: MAIL_GC_TIME,
    staleTime: 30_000,
    retry: shouldRetry,
  });
}

export function useMailbox(mailboxId: string | null | undefined) {
  const q = useQuery({
    queryKey: mailKeys.mailbox(mailboxId ?? ""),
    queryFn: () => mail.fetchMailbox(mailboxId as string),
    enabled: !!mailboxId,
    gcTime: MAIL_GC_TIME,
    retry: shouldRetry,
  });
  usePurgeOnForbidden(q.error, mailboxId);
  return q;
}

export function useThreads(mailboxId: string, view: Exclude<MailView, "drafts">, labelId?: string, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: mailKeys.threads(mailboxId, view, labelId),
    queryFn: ({ pageParam }) => mail.fetchThreads(mailboxId, { view, labelId, cursor: pageParam, limit: 25 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    gcTime: MAIL_GC_TIME,
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: shouldRetry,
  });
  usePurgeOnForbidden(q.error, mailboxId);
  return q;
}

export function useSearch(mailboxId: string | null, params: SearchParams, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: mailKeys.search(mailboxId, params),
    queryFn: ({ pageParam }) =>
      mailboxId ? mail.searchMailbox(mailboxId, { ...params, cursor: pageParam }) : mail.searchAll({ ...params, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    gcTime: MAIL_GC_TIME,
    retry: shouldRetry,
  });
}

export function useDrafts(mailboxId: string, enabled = true) {
  return useQuery({
    queryKey: mailKeys.drafts(mailboxId),
    queryFn: () => mail.fetchDrafts(mailboxId),
    enabled,
    gcTime: MAIL_GC_TIME,
    retry: shouldRetry,
  });
}

export function useLabels(mailboxId: string) {
  return useQuery({
    queryKey: mailKeys.labels(mailboxId),
    queryFn: () => mail.fetchLabels(mailboxId),
    gcTime: MAIL_GC_TIME,
    retry: shouldRetry,
  });
}

export function useThread(threadId: string | null | undefined) {
  return useQuery({
    queryKey: mailKeys.thread(threadId ?? ""),
    queryFn: () => mail.fetchThread(threadId as string),
    enabled: !!threadId,
    gcTime: MAIL_GC_TIME,
    retry: shouldRetry,
  });
}

export function useThreadMessages(threadId: string | null | undefined, remoteImages: "block" | "allow") {
  return useQuery({
    queryKey: mailKeys.messages(threadId ?? "", remoteImages),
    queryFn: () => mail.fetchThreadMessages(threadId as string, remoteImages),
    enabled: !!threadId,
    gcTime: MAIL_GC_TIME,
    retry: shouldRetry,
  });
}

export function useInvalidateMailbox() {
  const qc = useQueryClient();
  return (mailboxId?: string, threadId?: string) => {
    if (mailboxId) qc.invalidateQueries({ queryKey: ["mail", "mailbox", mailboxId] });
    if (threadId) qc.invalidateQueries({ queryKey: mailKeys.thread(threadId) });
    qc.invalidateQueries({ queryKey: mailKeys.entitlements });
  };
}

export function useThreadActions(mailboxId: string) {
  const invalidate = useInvalidateMailbox();
  const move = useMutation({
    mutationFn: ({ threadId, folder }: { threadId: string; folder: ThreadFolder }) => mail.moveThread(threadId, folder),
    onSuccess: (_d, v) => invalidate(mailboxId, v.threadId),
  });
  const state = useMutation({
    mutationFn: ({ threadId, ...body }: { threadId: string; isRead?: boolean; isStarred?: boolean }) =>
      mail.updateThreadState(threadId, body),
    onSuccess: (_d, v) => invalidate(mailboxId, v.threadId),
  });
  const bulk = useMutation({
    mutationFn: ({ threadIds, action }: { threadIds: string[]; action: BulkAction }) =>
      mail.bulkThreads(mailboxId, threadIds, action),
    onSuccess: () => invalidate(mailboxId),
  });
  return { move, state, bulk };
}

export function useQueue(mailboxId: string, status: string, assignee: string) {
  const q = useInfiniteQuery({
    queryKey: mailKeys.queue(mailboxId, status, assignee),
    queryFn: ({ pageParam }) =>
      mail.fetchQueue(mailboxId, {
        status: (status || undefined) as never,
        assignee: assignee || undefined,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    gcTime: MAIL_GC_TIME,
    refetchInterval: 30_000,
    retry: shouldRetry,
  });
  usePurgeOnForbidden(q.error, mailboxId);
  return q;
}

export function useMembers(mailboxId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: mailKeys.members(mailboxId ?? ""),
    queryFn: () => mail.fetchMembers(mailboxId as string),
    enabled: !!mailboxId && enabled,
    gcTime: MAIL_GC_TIME,
    retry: shouldRetry,
  });
}
