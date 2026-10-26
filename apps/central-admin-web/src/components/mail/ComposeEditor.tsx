"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bold, Italic, Link2, List, ListOrdered, Loader2, Paperclip, Send, Trash2, Underline, X } from "lucide-react";
import ContactPicker from "./ContactPicker";
import AttachmentViewer from "./AttachmentViewer";
import PermissionBoundary from "./PermissionBoundary";
import { useMailbox, usePreferences } from "./hooks";
import { newIdempotencyKey } from "./mail-utils";
import { sanitizeForEditor } from "./editor-sanitize";
import {
  classifyMailError,
  createDraft,
  discardDraft,
  fetchDraft,
  removeDraftAttachment,
  sendDraft,
  updateDraft,
  uploadDraftAttachment,
} from "@/lib/mail.service";
import type { Attachment, Draft, DraftMode, Party, SendResult } from "@/types/mail.types";

const AUTOSAVE_MS = 1500;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

interface ComposeEditorProps {
  mailboxId: string;
  draftId?: string | null;
  mode?: DraftMode;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  inline?: boolean;
  onClose: () => void;
  onSent?: (result: SendResult) => void;
}

export default function ComposeEditor({
  mailboxId,
  draftId,
  mode = "NEW",
  threadId,
  inReplyToMessageId,
  inline,
  onClose,
  onSent,
}: ComposeEditorProps) {
  const qc = useQueryClient();
  const mailboxQ = useMailbox(mailboxId);
  // Preferred sender (spec 15). The server already pre-selects it on new
  // drafts; this covers drafts that were saved without a sender.
  const prefsQ = usePreferences();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [senderAddressId, setSenderAddressId] = useState<string>("");
  // Optional Reply-To; only identities this user may send as are offered.
  const [replyToAddressId, setReplyToAddressId] = useState<string>("");
  const [to, setTo] = useState<Party[]>([]);
  const [cc, setCc] = useState<Party[]>([]);
  const [bcc, setBcc] = useState<Party[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState<{ currentRevision?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SendResult | null>(null);
  const [uploading, setUploading] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const revisionRef = useRef<number>(1);
  const createdRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idemKeyRef = useRef<string>(newIdempotencyKey());
  const savingRef = useRef<Promise<void> | null>(null);
  const pendingHtmlRef = useRef<string | null>(null);

  const applyDraft = useCallback((d: Draft, replaceBody: boolean) => {
    setDraft(d);
    revisionRef.current = d.revision;
    setSenderAddressId(d.senderAddressId ?? "");
    setTo(d.to);
    setCc(d.cc);
    setBcc(d.bcc);
    if (d.cc.length || d.bcc.length) setShowCc(true);
    setSubject(d.subject);
    setAttachments(d.attachments);
    if (replaceBody) pendingHtmlRef.current = d.html;
  }, []);

  // Apply server HTML once the editor element is mounted (sanitized first).
  useEffect(() => {
    if (editorRef.current && pendingHtmlRef.current !== null) {
      editorRef.current.innerHTML = sanitizeForEditor(pendingHtmlRef.current);
      pendingHtmlRef.current = null;
    }
  });

  // Create or load the server-side draft exactly once.
  useEffect(() => {
    if (createdRef.current) return;
    createdRef.current = true;
    (async () => {
      try {
        const d = draftId
          ? await fetchDraft(draftId)
          : await createDraft(mailboxId, { mode, threadId: threadId ?? null, inReplyToMessageId: inReplyToMessageId ?? null });
        applyDraft(d, true);
      } catch (err) {
        setLoadError(err);
      }
    })();
  }, [draftId, mailboxId, mode, threadId, inReplyToMessageId, applyDraft]);

  // Default the sender to the user's preferred identity when it belongs to
  // this mailbox, else the first approved identity. Waits for the preference
  // request so the choice does not flip once it arrives.
  useEffect(() => {
    const ids = mailboxQ.data?.senderIdentities ?? [];
    if (senderAddressId || !ids.length || !draft || prefsQ.isLoading) return;
    const preferred = prefsQ.data?.defaultSenderAddressId;
    const pick = (preferred && ids.find((s) => s.addressId === preferred)) || ids[0];
    setSenderAddressId(pick.addressId);
    setSaveState("dirty");
  }, [mailboxQ.data, senderAddressId, draft, prefsQ.isLoading, prefsQ.data]);

  const collect = useCallback(() => {
    const el = editorRef.current;
    return {
      senderAddressId: senderAddressId || null,
      to,
      cc,
      bcc,
      subject,
      html: el?.innerHTML ?? "",
      text: el?.innerText ?? "",
    };
  }, [senderAddressId, to, cc, bcc, subject]);

  const save = useCallback(async () => {
    if (!draft || conflict) return;
    if (savingRef.current) await savingRef.current;
    const run = (async () => {
      setSaveState("saving");
      try {
        const updated = await updateDraft(draft.id, { ...collect(), revision: revisionRef.current });
        revisionRef.current = updated.revision;
        setDraft(updated);
        setSaveState("saved");
      } catch (err) {
        const info = classifyMailError(err);
        if (info.code === "MAIL_DRAFT_REVISION_CONFLICT" || info.kind === "conflict") {
          setConflict({ currentRevision: typeof info.detail?.currentRevision === "number" ? info.detail.currentRevision : undefined });
        } else {
          setError(info.message);
        }
        setSaveState("error");
        throw err;
      }
    })();
    savingRef.current = run.catch(() => undefined);
    try {
      await run;
    } finally {
      savingRef.current = null;
    }
  }, [draft, conflict, collect]);

  const markDirty = useCallback(() => setSaveState("dirty"), []);

  // Debounced autosave.
  useEffect(() => {
    if (saveState !== "dirty" || !draft || conflict) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      save().catch(() => undefined);
    }, AUTOSAVE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [saveState, draft, conflict, save, to, cc, bcc, subject, senderAddressId]);

  // Warn about unsaved changes when leaving the page.
  useEffect(() => {
    const unsaved = !sent && (saveState === "dirty" || saveState === "saving" || saveState === "error");
    if (!unsaved) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveState, sent]);

  const resolveConflict = async (keepMine: boolean) => {
    if (!draft) return;
    setError(null);
    try {
      const latest = await fetchDraft(draft.id);
      if (keepMine) {
        revisionRef.current = latest.revision;
        setConflict(null);
        setSaveState("dirty");
      } else {
        applyDraft(latest, true);
        setConflict(null);
        setSaveState("saved");
      }
    } catch (err) {
      setError(classifyMailError(err).message);
    }
  };

  const exec = (command: string, value?: string) => {
    editorRef.current?.focus();
    // execCommand is deprecated but universally supported for simple formatting.
    document.execCommand(command, false, value);
    markDirty();
  };

  const insertLink = () => {
    const url = window.prompt("Link URL (https://…)");
    if (!url) return;
    if (!/^(https?:|mailto:)/i.test(url.trim())) {
      setError("Only https, http and mailto links are allowed.");
      return;
    }
    exec("createLink", url.trim());
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || !draft) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setError(`${file.name} is larger than 25 MB.`);
          continue;
        }
        const att = await uploadDraftAttachment(draft.id, file);
        setAttachments((a) => [...a, att]);
      }
    } catch (err) {
      setError(classifyMailError(err).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeAttachment = async (att: Attachment) => {
    if (!draft) return;
    try {
      await removeDraftAttachment(draft.id, att.id);
      setAttachments((a) => a.filter((x) => x.id !== att.id));
    } catch (err) {
      setError(classifyMailError(err).message);
    }
  };

  const send = async () => {
    if (!draft) return;
    setError(null);
    if (!senderAddressId) {
      setError("Choose an approved sender address.");
      return;
    }
    if (to.length + cc.length + bcc.length === 0) {
      setError("Add at least one recipient.");
      return;
    }
    const blocked = attachments.filter((a) => a.scanStatus !== "CLEAN");
    if (blocked.length) {
      setError("Remove attachments that are still scanning or were quarantined before sending.");
      return;
    }
    setSending(true);
    try {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (saveState !== "saved" && saveState !== "idle") await save();
      const result = await sendDraft(draft.id, revisionRef.current, idemKeyRef.current, replyToAddressId || null);
      setSent(result);
      setSaveState("idle");
      qc.invalidateQueries({ queryKey: ["mail", "mailbox", mailboxId] });
      if (result.threadId) qc.invalidateQueries({ queryKey: ["mail", "thread", result.threadId] });
      onSent?.(result);
    } catch (err) {
      const info = classifyMailError(err);
      if (info.kind !== "conflict") setError(info.message);
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    if (!draft) return onClose();
    if (!window.confirm("Discard this draft?")) return;
    try {
      await discardDraft(draft.id);
      setSaveState("idle");
      qc.invalidateQueries({ queryKey: ["mail", "mailbox", mailboxId, "drafts"] });
      onClose();
    } catch (err) {
      setError(classifyMailError(err).message);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  if (loadError || mailboxQ.error) {
    return <PermissionBoundary error={loadError || mailboxQ.error}>{null}</PermissionBoundary>;
  }
  if (!draft || mailboxQ.isLoading) {
    return <PermissionBoundary isLoading loadingLabel="Preparing draft">{null}</PermissionBoundary>;
  }

  if (sent) {
    // Show what the server actually returned: internal-only mail is already
    // delivered locally; anything with external recipients is only queued.
    const sentStatus: string = sent.status;
    const deliveredInternally = sentStatus === "DELIVERED";
    return (
      <div role="status" className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-[12px]">
        <p className="font-semibold text-foreground">{deliveredInternally ? "Message delivered internally." : "Message queued for sending."}</p>
        <p className="text-muted-foreground">
          {deliveredInternally
            ? "All recipients are internal mailboxes; it is already in their inboxes."
            : "It has not been delivered yet. Delivery status appears on the message once the provider reports it."}
        </p>
        <div>
          <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">
            Close
          </button>
        </div>
      </div>
    );
  }

  const identities = mailboxQ.data?.senderIdentities ?? [];
  const canSend = mailboxQ.data?.canSend && identities.length > 0;
  const saveLabel =
    saveState === "saving" ? "Saving…" : saveState === "saved" ? "Draft saved" : saveState === "dirty" ? "Unsaved changes" : saveState === "error" ? "Not saved" : "";

  return (
    <div
      className={`flex flex-col rounded-lg border border-border bg-card ${inline ? "" : "shadow-sm"}`}
      onKeyDown={onKeyDown}
      aria-label="Compose message"
      role="form"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold text-foreground">
          {mode === "REPLY" ? "Reply" : mode === "REPLY_ALL" ? "Reply all" : mode === "FORWARD" ? "Forward" : "New message"}
        </h2>
        <span className="ml-auto text-[11px] text-muted-foreground" aria-live="polite">{saveLabel}</span>
        <button type="button" onClick={onClose} aria-label="Close compose" className="rounded p-1 text-muted-foreground hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>

      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          This draft was changed elsewhere{conflict.currentRevision ? ` (revision ${conflict.currentRevision})` : ""}. Your edits were not saved.
          <button type="button" onClick={() => resolveConflict(false)} className="rounded border border-amber-300 px-2 py-0.5 font-semibold">
            Load latest
          </button>
          <button type="button" onClick={() => resolveConflict(true)} className="rounded border border-amber-300 px-2 py-0.5 font-semibold">
            Keep my version
          </button>
        </div>
      )}

      <div className="flex flex-col px-3">
        <div className="flex items-center gap-2 border-b border-border py-1.5">
          <label htmlFor="compose-from" className="w-10 shrink-0 text-[12px] text-muted-foreground">From</label>
          {identities.length === 0 ? (
            <span className="text-[12px] text-red-600">No approved sender identity for this mailbox.</span>
          ) : (
            <select
              id="compose-from"
              value={senderAddressId}
              onChange={(e) => {
                setSenderAddressId(e.target.value);
                markDirty();
              }}
              className="flex-1 bg-transparent text-[12px] outline-none"
            >
              {identities.map((s) => (
                <option key={s.addressId} value={s.addressId}>
                  {s.displayName ? `${s.displayName} <${s.address}>` : s.address}
                  {mailboxQ.data?.type === "SHARED" ? " (shared)" : ""}
                </option>
              ))}
            </select>
          )}
          {!showCc && (
            <button type="button" onClick={() => setShowCc(true)} className="text-[11px] font-semibold text-primary">
              Cc/Bcc
            </button>
          )}
        </div>
        {identities.length > 1 && (
          <div className="flex items-center gap-2 border-b border-border py-1.5">
            <label htmlFor="compose-reply-to" className="w-14 shrink-0 text-[12px] text-muted-foreground">Reply-To</label>
            <select
              id="compose-reply-to"
              value={replyToAddressId}
              onChange={(e) => setReplyToAddressId(e.target.value)}
              className="flex-1 bg-transparent text-[12px] outline-none"
            >
              <option value="">Same as From</option>
              {identities
                .filter((s) => s.addressId !== senderAddressId)
                .map((s) => (
                  <option key={s.addressId} value={s.addressId}>
                    {s.displayName ? `${s.displayName} <${s.address}>` : s.address}
                  </option>
                ))}
            </select>
          </div>
        )}
        <ContactPicker label="To" value={to} onChange={(v) => { setTo(v); markDirty(); }} autoFocus={mode === "NEW" || mode === "FORWARD"} />
        {showCc && (
          <>
            <ContactPicker label="Cc" value={cc} onChange={(v) => { setCc(v); markDirty(); }} />
            <ContactPicker label="Bcc" value={bcc} onChange={(v) => { setBcc(v); markDirty(); }} />
          </>
        )}
        <div className="flex items-center gap-2 border-b border-border py-1.5">
          <label htmlFor="compose-subject" className="w-10 shrink-0 text-[12px] text-muted-foreground">Subject</label>
          <input
            id="compose-subject"
            value={subject}
            maxLength={998}
            onChange={(e) => {
              setSubject(e.target.value);
              markDirty();
            }}
            className="flex-1 bg-transparent text-[12px] outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border px-3 py-1" role="toolbar" aria-label="Formatting">
        {[
          { cmd: "bold", icon: Bold, label: "Bold" },
          { cmd: "italic", icon: Italic, label: "Italic" },
          { cmd: "underline", icon: Underline, label: "Underline" },
          { cmd: "insertUnorderedList", icon: List, label: "Bulleted list" },
          { cmd: "insertOrderedList", icon: ListOrdered, label: "Numbered list" },
        ].map(({ cmd, icon: Icon, label }) => (
          <button key={cmd} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec(cmd)} aria-label={label} title={label} className="rounded p-1.5 text-muted-foreground hover:bg-muted">
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={insertLink} aria-label="Insert link" title="Insert link" className="rounded p-1.5 text-muted-foreground hover:bg-muted">
          <Link2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message body"
        onInput={markDirty}
        onPaste={(e) => {
          // Paste as plain text to avoid importing foreign markup.
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
        className={`overflow-y-auto px-3 py-2 text-[13px] text-foreground outline-none ${inline ? "min-h-[140px] max-h-[320px]" : "min-h-[260px] max-h-[55vh]"}`}
      />

      <div className="flex flex-col gap-2 px-3 pb-2">
        <AttachmentViewer attachments={attachments} onRemove={removeAttachment} />
        {error && <p role="alert" className="text-[12px] text-red-600">{error}</p>}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={send}
          disabled={sending || !canSend || !!conflict}
          title={canSend ? "Send (Ctrl+Enter)" : "You cannot send from this mailbox"}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {sending ? "Queueing…" : "Send"}
        </button>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} aria-label="Attach files" />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />} Attach
        </button>
        <button type="button" onClick={discard} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-muted">
          <Trash2 className="h-3.5 w-3.5" /> Discard
        </button>
      </div>
    </div>
  );
}
