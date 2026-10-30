"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert, TriangleAlert } from "lucide-react";
import { classifyMailError, downloadRawMessage, fetchMessageStatus, fetchOriginalHeaders } from "@/lib/mail.service";
import AttachmentViewer from "./AttachmentViewer";
import SafeHtmlFrame from "./SafeHtmlFrame";
import { formatFullDate, messageStatusLabel, partyLabel, recipientStatusLabel, statusTone, visibleDeliveryEvents } from "./mail-utils";
import type { MailMessage, OriginalHeaders, Recipient, SenderAuthentication } from "@/types/mail.types";

const AUTH_REASON_TEXT: Record<string, string> = {
  DMARC_FAIL: "the sender's domain policy (DMARC) check failed",
  SPF_FAIL_NO_DKIM: "the sending server is not authorized for this domain and the message is not signed",
  DKIM_FAIL: "the message signature (DKIM) did not verify",
  INTERNAL_DOMAIN_NOT_AUTHENTICATED: "it claims to come from one of our own domains but could not be verified",
};

function SenderAuthWarning({ auth }: { auth?: SenderAuthentication | null }) {
  if (!auth || (auth.verdict !== "FAIL" && auth.verdict !== "SUSPICIOUS")) return null;
  const reasons = auth.reasons.map((reason) => AUTH_REASON_TEXT[reason]).filter(Boolean);
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        Be careful with this message: the sender could not be verified{reasons.length ? ` (${reasons.join("; ")})` : ""}. Do not open links, attachments or payment requests unless you can confirm them another way.
      </span>
    </p>
  );
}

function OriginalMessage({ messageId }: { messageId: string }) {
  const [state, setState] = useState<{ loading: boolean; data?: OriginalHeaders; error?: string }>({ loading: false });
  const load = async () => {
    setState({ loading: true });
    try {
      setState({ loading: false, data: await fetchOriginalHeaders(messageId) });
    } catch (error) {
      setState({ loading: false, error: classifyMailError(error).message });
    }
  };
  if (!state.data) {
    return (
      <div>
        <button type="button" onClick={load} disabled={state.loading} className="text-[11px] font-semibold text-primary hover:underline disabled:opacity-50">
          {state.loading ? "Loading original…" : "Show original headers"}
        </button>
        {state.error && <p role="alert" className="text-[11px] text-red-600">{state.error}</p>}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border p-2 text-[11px]">
      {!state.data.available ? (
        <p className="text-muted-foreground">Original headers were not archived for this message.</p>
      ) : (
        <dl className="max-h-64 overflow-auto font-mono">
          {state.data.headers.map((header, index) => (
            <div key={`${header.name}-${index}`} className="break-all"><dt className="inline font-semibold">{header.name}:</dt> <dd className="inline">{header.value}</dd></div>
          ))}
        </dl>
      )}
      {state.data.rawMime.status === "STORED" && (
        <button type="button" onClick={() => downloadRawMessage(messageId).catch((error) => setState((s) => ({ ...s, error: classifyMailError(error).message })))} className="mt-1 font-semibold text-primary hover:underline">
          Download original (.eml)
        </button>
      )}
    </div>
  );
}

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
  allowRemoteImages = false,
}: {
  message: MailMessage;
  defaultExpanded: boolean;
  allowRemoteImages?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showDetails, setShowDetails] = useState(false);
  // Only the sender's OUTBOUND copy tracks delivery; INTERNAL copies list
  // header participants and must not show delivery details.
  const outbound = message.direction === "OUTBOUND";
  const deliveryEvents = visibleDeliveryEvents(message.deliveryEvents ?? []);
  const to = message.recipients.filter((r) => r.type === "TO");
  const cc = message.recipients.filter((r) => r.type === "CC");
  const bcc = message.recipients.filter((r) => r.type === "BCC");
  const when = message.sentAt || message.receivedAt || message.createdAt;
  // Spec 11.6: queued mail held for a provider quota reset says so (status API).
  const [waitNote, setWaitNote] = useState<string | null>(null);
  const queued = outbound && message.status === "QUEUED";
  useEffect(() => {
    if (!expanded || !queued) return;
    let active = true;
    fetchMessageStatus(message.id)
      .then((result) => { if (active) setWaitNote(result.statusDetail?.message ?? null); })
      .catch(() => { if (active) setWaitNote(null); });
    return () => { active = false; };
  }, [expanded, queued, message.id]);

  return (
    <article className="rounded-xl border border-border bg-card shadow-sm" aria-label={`Message from ${partyLabel(message.from)}`}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex min-h-14 w-full items-start gap-3 px-4 py-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{partyLabel(message.from)}</span>
            {message.sentBy && outbound && (
              <span className="text-xs text-muted-foreground">sent by {message.sentBy.name}</span>
            )}
            {(outbound || message.status === "QUARANTINED") && (
              <span className={`rounded-full border px-2 py-0.5 text-xs ${statusTone(message.status)}`}>{messageStatusLabel(message)}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground">{formatFullDate(when)}</span>
          </div>
          {!expanded && <p className="truncate text-xs text-muted-foreground">{(message.text ?? "").slice(0, 160)}</p>}
        </div>
      </button>
      {expanded && (
        <div className="flex flex-col gap-4 px-4 pb-5 sm:px-5">
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
            {outbound && showDetails && (
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
                <p className="mb-1 text-muted-foreground">
                  &ldquo;Delivered to receiving server&rdquo; means the recipient&rsquo;s mail server accepted it; it does not confirm the message reached the inbox.
                </p>
                {deliveryEvents.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-0.5 text-muted-foreground">
                    {deliveryEvents.map((ev, i) => (
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
          {queued && waitNote && (
            <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">{waitNote}</p>
          )}
          {message.status === "QUARANTINED" && (
            <p role="alert" className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              <ShieldAlert className="h-4 w-4" aria-hidden="true" />
              This message was quarantined{message.quarantineReason ? `: ${message.quarantineReason}` : "."}
            </p>
          )}
          {message.direction === "INBOUND" && <SenderAuthWarning auth={message.senderAuthentication} />}
          {message.html ? (
            <SafeHtmlFrame html={message.html} allowRemoteImages={allowRemoteImages} title={`Message body: ${message.subject || "no subject"}`} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-poppins text-[13px] text-foreground">{message.text || "(empty message)"}</pre>
          )}
          <AttachmentViewer attachments={message.attachments} />
          {message.direction === "INBOUND" && <OriginalMessage messageId={message.id} />}
        </div>
      )}
    </article>
  );
}
