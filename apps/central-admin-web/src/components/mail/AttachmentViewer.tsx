"use client";

import { useState } from "react";
import { Download, FileWarning, Paperclip, X } from "lucide-react";
import { SCAN_LABELS, formatBytes } from "./mail-utils";
import { classifyMailError, downloadAttachment } from "@/lib/mail.service";
import type { Attachment } from "@/types/mail.types";

export default function AttachmentViewer({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove?: (attachment: Attachment) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Inline images the server rendered into the body are not repeated here;
  // every other attachment (including inline ones it could not render) is listed.
  const visible = attachments.filter((a) => !(a as Attachment & { renderedInline?: boolean }).renderedInline);
  if (visible.length === 0) return null;

  const download = async (a: Attachment) => {
    setError(null);
    setBusy(a.id);
    try {
      await downloadAttachment(a);
    } catch (err) {
      setError(classifyMailError(err).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <ul className="flex flex-wrap gap-2" aria-label="Attachments">
        {visible.map((a) => {
          const safe = a.scanStatus === "CLEAN" && a.downloadable;
          return (
            <li
              key={a.id}
              className={`flex max-w-[260px] items-center gap-2 rounded-md border px-2 py-1.5 text-[11px] ${safe ? "border-border bg-card" : "border-amber-200 bg-amber-50"}`}
            >
              {safe ? (
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : (
                <FileWarning className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-foreground" title={a.filename}>{a.filename}</span>
                <span className="block text-muted-foreground">
                  {formatBytes(a.sizeBytes)} · {SCAN_LABELS[a.scanStatus]}
                </span>
              </span>
              {safe && (
                <button
                  type="button"
                  onClick={() => download(a)}
                  disabled={busy === a.id}
                  aria-label={`Download ${a.filename}`}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(a)}
                  aria-label={`Remove ${a.filename}`}
                  className="rounded p-1 text-muted-foreground hover:bg-muted"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
