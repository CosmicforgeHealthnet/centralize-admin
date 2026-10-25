"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-react";
import AttachmentViewer from "./AttachmentViewer";
import SafeHtmlFrame from "./SafeHtmlFrame";
import { STATUS_LABELS, formatFullDate, partyLabel, recipientStatusLabel, statusTone } from "./mail-utils";
import type { MailMessage, Recipient } from "@/types/mail.types";

function RecipientLine({ label, recipients }: { label: string; recipients: Recipient[] }) {
  if (!recipients.length) return null;
  return (
    <p className="text-[11px] text-muted-foreground">
      <span className="font-semibold">{label}:</span> {recipients.map((r) => partyLabel(r)).join(", ")}
    </p>
  );
}

export default function MessageCard({
  message,
  defaultExpanded,
}: {
  message: MailMessage;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showDetails, setShowDetails] = useState(false);
  const outbound = message.direction !== "INBOUND";
  const to = message.recipients.filter((r) => r.type === "TO");
  const cc = message.recipients.filter((r) => r.type === "CC");
  const bcc = message.recipients.filter((r) => r.type === "BCC");
  const when = message.sentAt || message.receivedAt || message.createdAt;

  return (
    <article className="rounded-lg border border-border bg-card" aria-label={`Message from ${partyLabel(message.from)}`}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-4 py-3 text-left"
      >
        {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-foreground">{partyLabel(message.from)}</span>
            {message.sentBy && outbound && (
              <span className="text-[11px] text-muted-foreground">sent by {message.sentBy.name}</span>
            )}
            {(outbound || message.status === "QUARANTINED") && (
              <span className={`rounded border px-1.5 text-[10px] ${statusTone(message.status)}`}>{STATUS_LABELS[message.status]}</span>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground">{formatFullDate(when)}</span>
          </div>
          {!expanded && <p className="truncate text-[11px] text-muted-foreground">{(message.text ?? "").slice(0, 160)}</p>}
        </div>
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4">
          <div>
            <RecipientLine label="To" recipients={to} />
            <RecipientLine label="Cc" recipients={cc} />
            <RecipientLine label="Bcc" recipients={bcc} />
            {message.replyTo && <p className="text-[11px] text-muted-foreground"><span className="font-semibold">Reply-To:</span> {message.replyTo}</p>}
            {outbound && (
              <button type="button" onClick={() => setShowDetails((s) => !s)} className="mt-1 text-[11px] font-semibold text-primary hover:underline" aria-expanded={showDetails}>
                {showDetails ? "Hide delivery details" : "Delivery details"}
              </button>
            )}
            {showDetails && (
              <div className="mt-2 rounded-md border border-border p-2 text-[11px]">
                <p className="mb-1 text-muted-foreground">
                  &ldquo;Accepted by provider&rdquo; means our email provider received the message; it does not confirm inbox delivery.
                </p>
                <ul className="flex flex-col gap-0.5">
                  {message.recipients.map((r) => (
                    <li key={`${r.type}-${r.address}`} className="flex gap-2">
                      <span className="w-8 text-muted-foreground">{r.type}</span>
                      <span className="flex-1 truncate">{r.address}</span>
                      <span className={`rounded border px-1 ${statusTone(r.status)}`}>{recipientStatusLabel(r.status)}</span>
                    </li>
                  ))}
                </ul>
                {message.deliveryEvents.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-0.5 text-muted-foreground">
                    {message.deliveryEvents.map((ev, i) => (
                      <li key={i}>
                        {formatFullDate(ev.occurredAt)} · {ev.type}
                        {ev.recipient ? ` · ${ev.recipient}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          {message.status === "QUARANTINED" && (
            <p role="alert" className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              <ShieldAlert className="h-4 w-4" aria-hidden="true" />
              This message was quarantined{message.quarantineReason ? `: ${message.quarantineReason}` : "."}
            </p>
          )}
          {message.html ? (
            <SafeHtmlFrame html={message.html} title={`Message body: ${message.subject || "no subject"}`} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-poppins text-[13px] text-foreground">{message.text || "(empty message)"}</pre>
          )}
          <AttachmentViewer attachments={message.attachments} />
        </div>
      )}
    </article>
  );
}
