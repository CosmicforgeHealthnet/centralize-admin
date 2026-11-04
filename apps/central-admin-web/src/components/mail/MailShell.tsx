"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, Menu, PenSquare, SearchX, X } from "lucide-react";
import MailState, { stateSecondaryActionClass } from "./MailState";
import MailSidebar from "./MailSidebar";
import { useClientReady } from "@/lib/use-client-ready";
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
  const clientReady = useClientReady();
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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const media = window.matchMedia("(min-width: 768px)");
    const onResize = () => { if (media.matches) setNavOpen(false); };
    media.addEventListener("change", onResize);
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
      document.body.style.overflow = previousOverflow;
      media.removeEventListener("change", onResize);
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

  if (!clientReady || entitlements.isLoading || entitlements.error) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <PermissionBoundary isLoading={!clientReady || entitlements.isLoading} error={entitlements.error} retry={() => entitlements.refetch()} loadingLabel="Loading mail">
          {null}
        </PermissionBoundary>
      </div>
    );
  }

  if (!mailbox) {
    // Not in the caller's entitlement list: treat exactly like forbidden.
    return (
      <div className="rounded-xl border border-border bg-card"><MailState icon={SearchX} role="alert" title="Mailbox not available" description="This mailbox is unavailable, or you no longer have access to it. Return to Mail to see your assigned mailboxes." actions={<Link href="/dashboard/mail" className={stateSecondaryActionClass}><ChevronLeft size={18} aria-hidden="true" />Back to Mail</Link>} />      </div>
    );
  }

  const folderNavigation = (<>
      <aside
        ref={navRef}
        role={navOpen ? "dialog" : undefined}
        aria-modal={navOpen ? true : undefined}
        aria-label={navOpen ? "Mail folders" : undefined}
        tabIndex={navOpen ? -1 : undefined}
        className={`mail-workspace ${navOpen ? "fixed inset-y-0 left-0 z-[101] w-[min(20rem,calc(100vw-2rem))] shadow-xl" : "hidden"} overflow-y-auto bg-card text-foreground md:bg-transparent md:static md:block md:w-[184px] md:shrink-0 md:shadow-none`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
          <h2 className="text-base font-semibold">Mail folders</h2>
          <button type="button" onClick={() => setNavOpen(false)} aria-label="Close folders" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
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
      {navOpen && <div aria-hidden="true" className="fixed inset-0 z-[100] bg-black/45 md:hidden" onClick={() => setNavOpen(false)} />}
  </>);

  return (
    <div className="flex min-h-[calc(100dvh-160px)] flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Mail</h1>
            
          </div>
        </div>
        {mailbox.canSend && mailbox.status === "ACTIVE" && (
          <Link
            href={`/dashboard/mail/compose?mailboxId=${mailbox.id}`}
            className="inline-flex min-h-11 shrink-0 md:hidden items-center gap-2 mail-compose-button rounded-xl px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <PenSquare className="h-4 w-4" aria-hidden="true" />
            <span>Compose</span>
          </Link>
        )}
      </header>

      <div className="flex h-[calc(100dvh-170px)] min-h-[420px] min-w-0 gap-3 overflow-hidden">
      {/* Folder navigation: drawer on mobile, column on desktop */}
      {navOpen ? createPortal(folderNavigation, document.body) : folderNavigation}

      {/* List pane: hidden on small screens while a thread is open */}
      <section
        aria-label="Conversation list"
        className={`${threadId ? "hidden" : "flex"} mail-inbox-pane min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card`}
      >
          <div className="flex items-start gap-2 border-b border-border p-3">
          <button ref={foldersButtonRef} type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary md:hidden" onClick={() => setNavOpen(true)} aria-label="Open folders" aria-haspopup="dialog" aria-expanded={navOpen}>
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
      <section aria-label="Conversation" className={`${threadId ? "flex" : "hidden"} min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card`}>
        {threadId && <ThreadDetail mailbox={mailbox} threadId={threadId} backHref={listHref} />}
      </section>
      </div>
    </div>
  );
}
