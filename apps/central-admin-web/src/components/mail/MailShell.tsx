"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Mail, Menu, PenSquare, X } from "lucide-react";
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
  const navRef = useRef<HTMLElement>(null);
  const foldersButtonRef = useRef<HTMLButtonElement>(null);

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
    if (!Object.keys(s).length) return null;
    // A text search inside a label keeps the label filter.
    if (labelId) s.labelId = labelId;
    return s;
  }, [params, labelId]);

  const mailboxes = entitlements.data?.mailboxes ?? [];
  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  const qs = params.toString();
  const listHref = `/dashboard/mail/${mailboxId}${qs ? `?${qs}` : ""}`;

  useEffect(() => {
    if (!navOpen) return;
    const drawer = navRef.current;
    if (!drawer) return;
    const focusReturnTarget = foldersButtonRef.current;
    const getFocusable = () => Array.from(drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    getFocusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setNavOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => focusReturnTarget?.focus());
    };
  }, [navOpen]);

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
    <div className="flex min-h-[calc(100dvh-150px)] flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden="true">
            <Mail className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Mail</h1>
            <p className="truncate text-sm text-muted-foreground">{mailbox.name} · {mailbox.primaryAddress}</p>
          </div>
        </div>
        {mailbox.canSend && mailbox.status === "ACTIVE" && (
          <Link
            href={`/dashboard/mail/compose?mailboxId=${mailbox.id}`}
            className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <PenSquare className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Compose</span>
            <span className="sm:hidden">New</span>
          </Link>
        )}
      </header>

      <div className="flex h-[calc(100dvh-190px)] min-h-[430px] min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Folder navigation: drawer on mobile, column on desktop */}
      <aside
        ref={navRef}
        role={navOpen ? "dialog" : undefined}
        aria-modal={navOpen ? true : undefined}
        aria-label={navOpen ? "Mail folders" : undefined}
        tabIndex={navOpen ? -1 : undefined}
        className={`${navOpen ? "fixed inset-y-0 left-0 z-40 w-[min(20rem,calc(100vw-2rem))] shadow-xl" : "hidden"} overflow-y-auto border-r border-border bg-card md:static md:block md:w-[210px] md:shrink-0 md:shadow-none`}
      >
        <div className="flex justify-end p-2 md:hidden">
          <button type="button" onClick={() => setNavOpen(false)} aria-label="Close folders">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div onClick={(event) => { if ((event.target as HTMLElement).closest("a[href]")) setNavOpen(false); }}>
        <MailSidebar
          mailboxes={mailboxes}
          mailbox={mailbox}
          view={view}
          labelId={labelId}
          queueActive={queueActive}
          sendingEnabled={!!entitlements.data?.sendingEnabled}
          onMailboxChange={() => setNavOpen(false)}
        />
        </div>
      </aside>
      {navOpen && <div aria-hidden="true" className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setNavOpen(false)} />}

      {/* List pane: hidden on small screens while a thread is open */}
      <section
        aria-label="Conversation list"
        className={`${threadId ? "hidden lg:flex" : "flex"} min-w-0 flex-1 flex-col border-r border-border lg:max-w-[380px]`}
      >
          <div className="flex items-center gap-2 border-b border-border p-2.5">
          <button ref={foldersButtonRef} type="button" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary md:hidden" onClick={() => setNavOpen(true)} aria-label="Open folders" aria-haspopup="dialog" aria-expanded={navOpen}>
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
              <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground" aria-hidden="true">
                <Mail className="h-7 w-7" />
              </span>
              <h2 className="text-base font-semibold text-foreground">Your reading space</h2>
              <p className="mt-1 max-w-xs text-sm leading-6">Choose a conversation from the list to read and reply. Your mailbox stays private to your account.</p>
              <p className="mt-4 text-xs text-muted-foreground">Shortcuts: <kbd>c</kbd> compose · <kbd>j</kbd>/<kbd>k</kbd> navigate · <kbd>e</kbd> archive · <kbd>r</kbd> reply · <kbd>/</kbd> search</p>
            </div>
          </div>
        )}
      </section>
      </div>
    </div>
  );
}
