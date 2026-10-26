"use client";

import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Clock3,
  FileText,
  Inbox,
  LockKeyhole,
  Mail,
  MailOpen,
  Menu,
  Search,
  Send,
  ShieldCheck,
  ShieldAlert,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MailView } from "@/types/mail.types";

// Staging-only presentation while the authenticated Mail API reports
// MAIL_DISABLED. Never fabricate a mailbox, sender identity, message or draft.
// The real MailShell automatically takes over when the API is enabled and a
// mailbox has been provisioned.
const FOLDERS: { id: MailView; name: string; icon: LucideIcon }[] = [
  { id: "inbox", name: "Inbox", icon: Inbox },
  { id: "unread", name: "Unread", icon: MailOpen },
  { id: "starred", name: "Starred", icon: Star },
  { id: "sent", name: "Sent", icon: Send },
  { id: "drafts", name: "Drafts", icon: FileText },
  { id: "archive", name: "Archive", icon: Archive },
  { id: "spam", name: "Spam", icon: ShieldAlert },
  { id: "trash", name: "Trash", icon: Trash2 },
];

export default function MailAwaitingActivation() {
  const [folder, setFolder] = useState<MailView>("inbox");
  const [foldersOpen, setFoldersOpen] = useState(false);
  const folderDrawer = useRef<HTMLElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const title = FOLDERS.find((entry) => entry.id === folder)?.name ?? "Inbox";

  useEffect(() => {
    if (!foldersOpen) return;
    const drawer = folderDrawer.current;
    const button = openButton.current;
    const previousOverflow = document.body.style.overflow;
    const focusable = () => Array.from(drawer?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    document.body.style.overflow = "hidden";
    focusable()[0]?.focus();

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFoldersOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes[nodes.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) {
        event.preventDefault();
        nodes[0].focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = previousOverflow;
      button?.focus();
    };
  }, [foldersOpen]);

  const selectFolder = (nextFolder: MailView) => {
    setFolder(nextFolder);
    setFoldersOpen(false);
  };

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-9rem)] w-full max-w-[1760px] flex-col gap-5 pb-2">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[#dfe2f7] bg-[#f0f1ff] text-[#343b9b] shadow-sm dark:border-[#42466d] dark:bg-[#23264d] dark:text-[#c6caff]" aria-hidden="true">
            <Mail className="h-[22px] w-[22px]" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">CosmicForge workspace</p>
            <h1 className="font-sans text-[25px] font-bold leading-tight tracking-[-0.035em] text-foreground sm:text-[28px]">Mail</h1>
            <p className="mt-1 text-[13px] text-muted-foreground sm:text-sm">A calmer place for your work conversations.</p>
          </div>
        </div>

        <div className="flex items-center gap-3 sm:pb-0.5">
          <span className="hidden items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
            Setup in progress
          </span>
          <button
            type="button"
            disabled
            aria-describedby="mail-compose-unavailable"
            title="Compose becomes available when your authorized staging mailbox is connected"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-muted-foreground shadow-sm transition-colors disabled:cursor-not-allowed disabled:bg-muted/70 disabled:shadow-none"
          >
            <LockKeyhole className="h-4 w-4" aria-hidden="true" />
            Compose
          </button>
          <span id="mail-compose-unavailable" className="sr-only">Compose is unavailable until an authorized staging mailbox is connected.</span>
        </div>
      </header>

      <section role="status" aria-live="polite" className="flex items-start gap-3 rounded-2xl border border-[#dfe2f7] bg-[#f7f8ff] px-4 py-3.5 text-[#252c74] dark:border-[#42466d] dark:bg-[#191b35] dark:text-[#e1e3ff] sm:items-center sm:px-5">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/80 text-[#343b9b] dark:bg-white/10 dark:text-[#c6caff] sm:mt-0" aria-hidden="true">
          <Clock3 className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-5">Your Mail workspace is being prepared</h2>
          <p className="mt-0.5 max-w-4xl text-xs leading-5 text-[#555b91] dark:text-[#b9bcdf] sm:text-[13px]">
            The interface is available, but no authorized mailbox is connected yet. Real messages and drafts will appear after mailbox access is activated. Nothing is sent or saved from this view.
          </p>
        </div>
        <span className="hidden shrink-0 rounded-full border border-[#d4d7f1] bg-white/70 px-2.5 py-1 text-[11px] font-semibold text-[#343b9b] dark:border-[#4c5076] dark:bg-white/5 dark:text-[#d1d4ff] sm:inline-flex">Awaiting activation</span>
      </section>

      <section aria-label="Mail workspace" className="grid h-[calc(100dvh-24rem)] min-h-[450px] flex-1 grid-cols-1 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_8px_30px_rgba(23,31,72,0.06)] dark:shadow-none lg:h-[calc(100dvh-260px)] lg:min-h-[490px] lg:grid-cols-[220px_minmax(300px,0.92fr)_minmax(290px,1.15fr)]">
        <aside
          ref={folderDrawer}
          role={foldersOpen ? "dialog" : undefined}
          aria-modal={foldersOpen ? true : undefined}
          aria-label="Mail folders"
          className={`${foldersOpen ? "fixed inset-y-0 left-0 z-50 flex w-[min(20rem,calc(100vw-2.5rem))] shadow-2xl" : "hidden"} flex-col overflow-y-auto border-r border-border bg-card lg:static lg:z-auto lg:flex lg:w-auto lg:shadow-none`}
        >
          <div className="flex h-[60px] shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#f0f1ff] text-[#343b9b] dark:bg-[#23264d] dark:text-[#c6caff]" aria-hidden="true">
                <Mail className="h-4 w-4" strokeWidth={1.8} />
              </span>
              <span className="text-[13px] font-semibold tracking-tight">CosmicForge Mail</span>
            </div>
            <button type="button" onClick={() => setFoldersOpen(false)} className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary lg:hidden" aria-label="Close folders">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <nav aria-label="Mail folders" className="flex min-h-0 flex-1 flex-col px-3 py-4">
            <div className="mb-5 rounded-xl border border-border bg-muted/50 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Mailbox</span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-[10px] font-medium text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                  Not connected
                </span>
              </div>
              <p className="mt-2 text-[13px] font-semibold text-foreground">No active mailbox</p>
              <p className="mt-1 text-xs leading-[1.55] text-muted-foreground">An authorized mailbox will appear here when access is provisioned.</p>
            </div>

            <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Folders</p>
            <div className="flex flex-col gap-1">
              {FOLDERS.map(({ id, name, icon: Icon }) => {
                const active = folder === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => selectFolder(id)}
                    aria-current={active ? "page" : undefined}
                    className={`group relative flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary ${active ? "bg-[#f0f1ff] font-semibold text-[#303789] dark:bg-[#25284d] dark:text-[#e0e2ff]" : "font-medium text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                  >
                    {active && <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-primary" aria-hidden="true" />}
                    <Icon className={`ml-0.5 h-[17px] w-[17px] shrink-0 ${active ? "text-[#3a42a4] dark:text-[#b9beff]" : "text-muted-foreground group-hover:text-foreground"}`} strokeWidth={1.8} aria-hidden="true" />
                    <span>{name}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-auto border-t border-border px-1 pt-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4 text-[#4f58b3] dark:text-[#b9beff]" aria-hidden="true" />
                Private by design
              </div>
              <p className="mt-1.5 pl-6 text-[11px] leading-[1.55] text-muted-foreground">Only mail authorized for your account can appear here.</p>
            </div>
          </nav>
        </aside>

        {foldersOpen && <button type="button" tabIndex={-1} aria-label="Close folder drawer" className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[1px] lg:hidden" onClick={() => setFoldersOpen(false)} />}

        <section aria-label="Conversation list" className="flex min-h-0 min-w-0 flex-col border-border lg:border-r">
          <div className="flex h-[60px] shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <button ref={openButton} type="button" className="-ml-2 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary lg:hidden" onClick={() => setFoldersOpen(true)} aria-label="Open folders" aria-haspopup="dialog" aria-expanded={foldersOpen}>
                <Menu className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Current folder</p>
                <h2 className="truncate text-sm font-semibold leading-5 text-foreground">{title}</h2>
              </div>
            </div>
            <span className="hidden rounded-full bg-muted px-2.5 py-1 text-[10px] font-medium text-muted-foreground sm:inline-flex">Mailbox pending</span>
          </div>

          <div className="border-b border-border p-3 sm:px-4">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/80" aria-hidden="true" />
              <input
                type="search"
                disabled
                aria-label="Search conversations, unavailable until mailbox activation"
                placeholder="Search conversations"
                className="h-10 w-full rounded-xl border border-border bg-muted/40 pl-9 pr-3 text-xs text-muted-foreground placeholder:text-muted-foreground/80 disabled:cursor-not-allowed disabled:opacity-100"
              />
            </label>
          </div>

          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center">
            <span className="mb-5 flex h-[58px] w-[58px] items-center justify-center rounded-[18px] border border-[#e5e7f4] bg-[#f6f7fc] text-[#67709c] dark:border-[#34364d] dark:bg-[#20212b] dark:text-[#b0b5d8]" aria-hidden="true">
              <Inbox className="h-[25px] w-[25px]" strokeWidth={1.6} />
            </span>
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">{title}</p>
            <h3 className="mt-2 text-[15px] font-semibold tracking-tight text-foreground">Mailbox not connected</h3>
            <p className="mt-2 max-w-[290px] text-[13px] leading-[1.7] text-muted-foreground">
              This folder is ready, but it can’t show messages until an authorized mailbox is activated.
            </p>
            <span className="mt-5 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
              <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
              No messages or drafts loaded
            </span>
          </div>
        </section>

        <section aria-label="Conversation reading pane" className="hidden min-h-0 min-w-0 flex-col bg-[#fdfdfe] dark:bg-[#171719] lg:flex">
          <div className="flex h-[60px] shrink-0 items-center border-b border-border px-5">
            <h2 className="text-[13px] font-semibold text-foreground">Reading pane</h2>
          </div>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-12 text-center">
            <span className="mb-5 flex h-[62px] w-[62px] items-center justify-center rounded-[20px] border border-[#e5e7f4] bg-white text-[#67709c] shadow-sm dark:border-[#34364d] dark:bg-[#20212b] dark:text-[#b0b5d8] dark:shadow-none" aria-hidden="true">
              <Mail className="h-[27px] w-[27px]" strokeWidth={1.55} />
            </span>
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">A quieter space to read</h3>
            <p className="mt-2 max-w-[300px] text-[13px] leading-[1.7] text-muted-foreground">
              Conversation details will appear here when an authorized mailbox is connected. Private mail stays protected by account access checks.
            </p>
          </div>
          <div className="border-t border-border px-5 py-3">
            <p className="text-[11px] text-muted-foreground">No conversation selected</p>
          </div>
        </section>
      </section>
    </div>
  );
}
