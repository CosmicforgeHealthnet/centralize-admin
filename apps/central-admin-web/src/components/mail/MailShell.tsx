"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Menu, X } from "lucide-react";
import MailSidebar from "./MailSidebar";
import InboxList from "./InboxList";
import ThreadDetail from "./ThreadDetail";
import MailSearch from "./MailSearch";
import SharedQueue from "./SharedQueue";
import PermissionBoundary from "./PermissionBoundary";
import { useEntitlements } from "./hooks";
import { isMailView, isTypingTarget } from "./mail-utils";
import type { MailView, SearchParams } from "@/types/mail.types";

export default function MailShell({ mailboxId, threadId }: { mailboxId: string; threadId?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const entitlements = useEntitlements();
  const [navOpen, setNavOpen] = useState(false);

  const rawView = params.get("view");
  const queueActive = rawView === "queue";
  const view: MailView = isMailView(rawView) ? rawView : "inbox";
  const labelId = params.get("labelId") ?? undefined;
  const search: SearchParams | null = useMemo(() => {
    const s: SearchParams = {};
    for (const k of ["q", "from", "to", "subject", "after", "before"] as const) {
      const v = params.get(k);
      if (v) s[k] = v;
    }
    return Object.keys(s).length ? s : null;
  }, [params]);

  const mailboxes = entitlements.data?.mailboxes ?? [];
  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  const qs = params.toString();
  const listHref = `/dashboard/mail/${mailboxId}${qs ? `?${qs}` : ""}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c" && mailbox?.canSend) {
        e.preventDefault();
        router.push(`/dashboard/mail/compose?mailboxId=${mailboxId}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mailbox, mailboxId, router]);

  if (entitlements.isLoading || entitlements.error) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <PermissionBoundary isLoading={entitlements.isLoading} error={entitlements.error} retry={() => entitlements.refetch()} loadingLabel="Loading mail">
          {null}
        </PermissionBoundary>
      </div>
    );
  }

  if (!mailbox) {
    // Not in the caller's entitlement list: treat exactly like forbidden.
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center" role="alert">
        <h2 className="text-sm font-semibold">Mailbox not available</h2>
        <p className="mt-1 text-xs text-muted-foreground">This mailbox does not exist or you no longer have access to it.</p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-120px)] min-h-[520px] overflow-hidden rounded-lg border border-border bg-card">
      {/* Folder navigation: drawer on mobile, column on desktop */}
      <aside
        className={`${navOpen ? "fixed inset-y-0 left-0 z-40 w-[260px] shadow-xl" : "hidden"} overflow-y-auto border-r border-border bg-card md:static md:block md:w-[210px] md:shrink-0 md:shadow-none`}
      >
        <div className="flex justify-end p-2 md:hidden">
          <button type="button" onClick={() => setNavOpen(false)} aria-label="Close folders">
            <X className="h-4 w-4" />
          </button>
        </div>
        <MailSidebar
          mailboxes={mailboxes}
          mailbox={mailbox}
          view={view}
          labelId={labelId}
          queueActive={queueActive}
          sendingEnabled={!!entitlements.data?.sendingEnabled}
        />
      </aside>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setNavOpen(false)} />}

      {/* List pane: hidden on small screens while a thread is open */}
      <section
        aria-label="Conversation list"
        className={`${threadId ? "hidden lg:flex" : "flex"} min-w-0 flex-1 flex-col border-r border-border lg:max-w-[380px]`}
      >
        <div className="flex items-center gap-2 border-b border-border p-2">
          <button type="button" className="rounded p-1.5 hover:bg-muted md:hidden" onClick={() => setNavOpen(true)} aria-label="Open folders">
            <Menu className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <MailSearch />
          </div>
        </div>
        {!entitlements.data?.sendingEnabled && (
          <p className="border-b border-border bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
            Outbound sending is disabled in this environment. Drafts are saved but cannot be sent.
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {queueActive && mailbox.type === "SHARED" && !search ? (
            <SharedQueue mailbox={mailbox} />
          ) : (
            <InboxList mailbox={mailbox} view={view} labelId={labelId} search={search} selectedThreadId={threadId} />
          )}
        </div>
      </section>

      {/* Reading pane */}
      <section aria-label="Conversation" className={`${threadId ? "flex" : "hidden lg:flex"} min-w-0 flex-[1.4] flex-col`}>
        {threadId ? (
          <ThreadDetail mailbox={mailbox} threadId={threadId} backHref={listHref} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-[12px] text-muted-foreground">
            <div>
              <p>Select a conversation to read it.</p>
              <p className="mt-1">Shortcuts: c compose · j/k next/previous · e archive · # trash · r reply · / search</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
