"use client";

import { useEffect, useRef, useState } from "react";
import {
  Archive, FileText, Inbox, Mail, MailOpen, Menu, PenSquare, Send, ShieldAlert,
  Star, Trash2, X,
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
    const focusable = () => Array.from(drawer?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
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
      button?.focus();
    };
  }, [foldersOpen]);

  return (
    <div className="flex min-h-[calc(100dvh-150px)] flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden="true">
            <Mail className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Mail</h1>
            <p className="text-sm text-muted-foreground">Your email workspace</p>
          </div>
        </div>
        <button
          type="button"
          disabled
          title="Compose becomes available when your secure staging mailbox is provisioned"
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground opacity-50"
        >
          <PenSquare className="h-4 w-4" aria-hidden="true" /> Compose
        </button>
      </header>

      <div role="status" className="rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <strong>Mailbox connection pending.</strong> Your Mail interface is available here, but your real
        messages, drafts and sending controls require an activated, authorized staging mailbox.
        The email provider can be connected later. Nothing is being sent or stored from this view.
      </div>

      <div className="flex h-[calc(100dvh-230px)] min-h-[430px] min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <aside
          ref={folderDrawer}
          role={foldersOpen ? "dialog" : undefined}
          aria-modal={foldersOpen ? true : undefined}
          aria-label="Mail folders"
          className={`${foldersOpen ? "fixed inset-y-0 left-0 z-40 w-[min(20rem,calc(100vw-2rem))] shadow-xl" : "hidden"} overflow-y-auto border-r border-border bg-card md:static md:block md:w-[210px] md:shrink-0 md:shadow-none`}
        >
          <div className="flex justify-end p-2 md:hidden">
            <button type="button" onClick={() => setFoldersOpen(false)} className="rounded-md p-2 focus-visible:outline-2 focus-visible:outline-primary" aria-label="Close folders">
              <X className="h-4 w-4" />
            </button>
          </div>
          <nav aria-label="Mail folders" className="flex flex-col gap-3 p-3">
            <div className="rounded-lg border border-border px-3 py-3">
              <p className="text-xs font-semibold">No active mailbox</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">An approved staging mailbox will appear here when connected.</p>
            </div>
            <div className="space-y-0.5">
              {FOLDERS.map(({ id, name, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setFolder(id); setFoldersOpen(false); }}
                  aria-current={folder === id ? "page" : undefined}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary ${folder === id ? "bg-primary/10 font-semibold text-foreground" : "text-muted-foreground hover:bg-muted"}`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" /> {name}
                </button>
              ))}
            </div>
          </nav>
        </aside>
        {foldersOpen && <button type="button" tabIndex={-1} aria-label="Close folder drawer" className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setFoldersOpen(false)} />}

        <section aria-label="Conversation list" className="flex min-w-0 flex-1 flex-col border-r border-border lg:max-w-[380px]">
          <div className="flex min-h-14 items-center gap-3 border-b border-border px-4">
            <button ref={openButton} type="button" className="rounded-md p-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary md:hidden" onClick={() => setFoldersOpen(true)} aria-label="Open folders" aria-haspopup="dialog" aria-expanded={foldersOpen}>
              <Menu className="h-5 w-5" />
            </button>
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground" aria-hidden="true">
              <Inbox className="h-6 w-6" />
            </span>
            <h3 className="text-sm font-semibold">Mailbox not connected</h3>
            <p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">
              Messages will appear here when the Mail database, secure storage and your mailbox are activated.
            </p>
          </div>
        </section>

        <section aria-label="Conversation" className="hidden min-w-0 flex-[1.4] flex-col items-center justify-center p-8 text-center lg:flex">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground" aria-hidden="true">
            <Mail className="h-7 w-7" />
          </span>
          <h2 className="text-base font-semibold">Your reading space</h2>
          <p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">
            Once your mailbox is connected, select a conversation to read and reply.
            Private mail is never shown without a verified entitlement.
          </p>
        </section>
      </div>
    </div>
  );
}
