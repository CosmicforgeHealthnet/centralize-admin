"use client";

// IT > Mail Administration > Quarantine (final gap 6). Quarantined messages
// and attachments with SAFE METADATA ONLY: mailbox, brand, time, size, sender
// domain (masked local part), reason category, attachment name/type/size and
// scan status. No subjects, bodies, previews or downloads are ever requested
// or shown, and acting here never grants mailbox access.
// Release needs a reason + 2FA step-up (MAIL_QUARANTINE_RELEASE); reject and
// delete need a reason + step-up (MAIL_QUARANTINE_DELETE). Infected content
// can never be released; release needs clean scan evidence.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import StepUpDialog from "@/components/marketing/email-marketing/StepUpDialog";
import { formatFullDate } from "@/components/mail/mail-utils";
import api from "@/lib/api";
import { classifyMailError } from "@/lib/mail.service";
import * as adminApi from "@/lib/mail-admin.service";

type Kind = "messages" | "attachments";
type Action = "release" | "reject" | "delete";

interface Sender { domain: string | null; masked: string | null; hash: string | null }
interface QAttachment { id: string; filename: string; contentType: string; sizeBytes: number; scanStatus: string; scanDetail: string | null; reasonCategory: string; removed: boolean }
interface QActions { available: boolean; canRelease: boolean; releaseBlockers: string[]; canDelete: boolean; canRescan?: boolean }
interface QDecision { id: string; targetType: string; messageId: string | null; attachmentId: string | null; decision: string; reason: string; scanEvidence: Record<string, unknown> | null; decidedBy: string; createdAt: string }
export interface QuarantineItem {
  id: string;
  kind: "MESSAGE" | "ATTACHMENT";
  source: string;
  status?: string;
  mailbox: { id: string; name: string };
  organization: { id: string; name: string } | null;
  receivedAt?: string | null;
  createdAt?: string | null;
  sizeBytes: number;
  sender: Sender | null;
  reason?: string | null;
  reasonCategory: string;
  authVerdict?: string | null;
  attachments?: QAttachment[];
  filename?: string;
  // Private draft files: the server sends only "*.ext" (never the name).
  filenameMasked?: boolean;
  contentType?: string;
  scanStatus?: string;
  scanDetail?: string | null;
  removed?: boolean;
  actions: QActions;
  decisions?: QDecision[];
}

const card = "rounded-xl border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-2 py-1.5 text-[12px] outline-none focus:border-primary";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";
const ghost = "rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50";
const danger = "rounded-md bg-red-700 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50";
const th = "py-1.5 pr-3 text-left text-[11px] font-semibold text-muted-foreground";
const td = "py-1.5 pr-3 align-top text-[12px]";
const FORBIDDEN = "Quarantine is available to mail administrators with an explicit Mail administration grant.";

const CATEGORY_LABEL: Record<string, string> = {
  MALWARE: "Malware",
  AUTH_POLICY: "Sender authentication",
  SPAM: "Spam verdict",
  POLICY: "File / MIME policy",
  SCAN_FAILURE: "Scan failure",
};
const CATEGORY_TONE: Record<string, string> = {
  MALWARE: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  AUTH_POLICY: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  SCAN_FAILURE: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
};
const BLOCKER_LABEL: Record<string, string> = {
  MALWARE_NEVER_RELEASABLE: "Malware is never released.",
  INFECTED_ATTACHMENT: "An attachment is infected.",
  INFECTED_NEVER_RELEASABLE: "Infected files are never released.",
  ATTACHMENT_NOT_CLEAN: "Every attachment needs a clean scan first. Rescan unscanned files.",
  CLEAN_SCAN_REQUIRED: "A clean scan is required first. Rescan the file.",
  POLICY_BLOCKED: "This file type is blocked by policy and cannot be released.",
  NOT_QUARANTINED: "Already released or resolved.",
  REMOVED: "The file was removed.",
};

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Category({ value }: { value: string }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_TONE[value] || "bg-muted text-muted-foreground"}`}>{CATEGORY_LABEL[value] ?? value}</span>;
}

function errorText(error: unknown) {
  const info = classifyMailError(error);
  const reason = info.detail?.reason as string | undefined;
  if (reason && BLOCKER_LABEL[reason]) return BLOCKER_LABEL[reason];
  if (info.code === "MAIL_LEGAL_HOLD") return "This item is under legal hold and cannot be removed.";
  if (info.code === "MAIL_FEATURE_NOT_READY") return "Quarantine actions are not available until the latest Mail database migration is applied.";
  return info.message;
}

const PURPOSE: Record<Action, string> = { release: "MAIL_QUARANTINE_RELEASE", reject: "MAIL_QUARANTINE_DELETE", delete: "MAIL_QUARANTINE_DELETE" };
const ACTION_LABEL: Record<Action, string> = { release: "Release", reject: "Reject", delete: "Delete" };

async function fetchList(kind: Kind, filters: Record<string, string>, cursor: string | null) {
  const params = Object.fromEntries(Object.entries({ ...filters, kind, cursor: cursor ?? "" }).filter(([, value]) => value));
  const response = await api.get<{ data: QuarantineItem[]; meta?: { nextCursor?: string | null } }>("/api/mail/v1/admin/quarantine", { params });
  return { items: response.data.data, nextCursor: response.data.meta?.nextCursor ?? null };
}

async function fetchDetail(item: { id: string; kind: QuarantineItem["kind"] }) {
  const response = item.kind === "MESSAGE"
    ? await api.get<{ data: QuarantineItem }>(`/api/mail/v1/admin/quarantine/messages/${item.id}`)
    : await api.get<{ data: QuarantineItem }>(`/api/mail/v1/admin/quarantine/attachments/${item.id}`);
  return response.data.data;
}

async function runAction(item: { id: string; kind: QuarantineItem["kind"] }, action: Action, body: { reason: string; stepUpId: string }) {
  if (item.kind === "MESSAGE") return (await api.post(`/api/mail/v1/admin/quarantine/messages/${item.id}/${action}`, body)).data;
  return (await api.post(`/api/mail/v1/admin/quarantine/attachments/${item.id}/${action}`, body)).data;
}

async function rescan(attachmentId: string) {
  return (await api.post(`/api/mail/v1/admin/quarantine/attachments/${attachmentId}/rescan`, {})).data;
}

function Detail({ target, canEdit, onClose, onChanged }: { target: { id: string; kind: QuarantineItem["kind"] }; canEdit: boolean; onClose: () => void; onChanged: (message: string) => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["mail", "admin", "quarantine", "detail", target.kind, target.id], queryFn: () => fetchDetail(target), retry: false });
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<Action | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    pendingRef.current = pending;
    onCloseRef.current = onClose;
  }, [pending, onClose]);
  // Focus moves into the drawer on open and back to the opener on close;
  // Escape closes it (the step-up dialog handles its own Escape).
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pendingRef.current) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail", "admin", "quarantine"] });
  const rescanMutation = useMutation({
    mutationFn: rescan,
    onSuccess: () => { setError(null); onChanged("Rescan finished. A clean file stays quarantined until you release it."); refresh(); },
    onError: (e) => setError(errorText(e)),
  });
  const item = detail.data;
  const reasonOk = reason.trim().length >= 5;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="presentation" onClick={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <aside role="dialog" aria-modal="true" aria-labelledby="quarantine-detail-h" className="flex h-full w-full max-w-md flex-col gap-3 overflow-y-auto border-l border-border bg-card p-4 shadow-xl">
        <div className="flex items-center gap-2">
          <h3 id="quarantine-detail-h" className="text-[14px] font-semibold">{target.kind === "MESSAGE" ? "Quarantined message" : "Quarantined attachment"}</h3>
          <button ref={closeRef} type="button" className={`${ghost} ml-auto`} onClick={onClose}>Close</button>
        </div>
        <PermissionBoundary isLoading={detail.isLoading} error={detail.error} compact forbiddenMessage={FORBIDDEN}>
          {item && (
            <>
              <dl className="grid grid-cols-[120px_1fr] gap-x-2 gap-y-1 text-[12px]">
                <dt className="text-muted-foreground">Mailbox</dt><dd>{item.mailbox.name}</dd>
                <dt className="text-muted-foreground">Brand</dt><dd>{item.organization?.name ?? "—"}</dd>
                <dt className="text-muted-foreground">Received</dt><dd>{formatFullDate(item.receivedAt || item.createdAt || "")}</dd>
                <dt className="text-muted-foreground">Sender</dt><dd>{item.sender?.masked ?? "—"}{item.sender?.hash ? <span className="ml-1 text-[10px] text-muted-foreground">#{item.sender.hash}</span> : null}</dd>
                <dt className="text-muted-foreground">Reason</dt><dd><Category value={item.reasonCategory} /> {item.reason ? <span className="ml-1 text-[11px] text-muted-foreground">{item.reason}</span> : null}</dd>
                {item.authVerdict && (<><dt className="text-muted-foreground">Sender auth</dt><dd>{item.authVerdict}</dd></>)}
                <dt className="text-muted-foreground">Size</dt><dd>{size(item.sizeBytes)}</dd>
                {item.kind === "ATTACHMENT" && (
                  <>
                    <dt className="text-muted-foreground">File</dt><dd>{item.filename} <span className="text-muted-foreground">({item.contentType})</span>{item.filenameMasked ? <span className="block text-[10px] text-muted-foreground">Private draft file: only the file type and size are shown.</span> : null}</dd>
                    <dt className="text-muted-foreground">Scan</dt><dd>{item.scanStatus}{item.scanDetail ? ` · ${item.scanDetail}` : ""}</dd>
                    <dt className="text-muted-foreground">Source</dt><dd>{item.source === "OUTBOUND_DRAFT" ? "Outgoing draft" : "Received email"}</dd>
                  </>
                )}
              </dl>
              {item.kind === "MESSAGE" && (
                <section aria-labelledby="q-att-h">
                  <h4 id="q-att-h" className="mb-1 text-[12px] font-semibold">Attachments</h4>
                  {(item.attachments ?? []).length === 0 && <p className="text-[11px] text-muted-foreground">No attachments.</p>}
                  <ul className="flex flex-col gap-1 text-[12px]">
                    {(item.attachments ?? []).map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center gap-2 rounded border border-border p-1.5">
                        <span className="font-medium">{a.filename}</span>
                        <span className="text-muted-foreground">{size(a.sizeBytes)}</span>
                        <span className="text-[11px]">{a.removed ? "removed" : a.scanStatus}{a.scanDetail ? ` · ${a.scanDetail}` : ""}</span>
                        {canEdit && item.actions.available && !a.removed && ["PENDING", "SCAN_FAILED", "SCANNER_UNAVAILABLE"].includes(a.scanStatus) && !String(a.scanDetail || "").startsWith("POLICY_") && (
                          <button type="button" className={`${ghost} ml-auto`} disabled={rescanMutation.isPending} onClick={() => rescanMutation.mutate(a.id)} aria-label={`Rescan ${a.filename}`}>Rescan</button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {!item.actions.available && <p role="status" className="rounded bg-muted/50 p-2 text-[11px]">Read-only: quarantine actions become available once the latest Mail database migration is applied.</p>}
              {item.actions.available && canEdit && (
                <section aria-labelledby="q-actions-h" className="flex flex-col gap-2">
                  <h4 id="q-actions-h" className="text-[12px] font-semibold">Decision</h4>
                  {!item.actions.canRelease && item.actions.releaseBlockers.length > 0 && (
                    <ul className="text-[11px] text-muted-foreground">
                      {item.actions.releaseBlockers.map((blocker) => <li key={blocker}>{BLOCKER_LABEL[blocker] ?? blocker}</li>)}
                    </ul>
                  )}
                  <label htmlFor="q-reason" className="text-[11px] text-muted-foreground">Reason (recorded in the decision log; at least 5 characters). Do not paste message content, subjects or file contents.</label>
                  <textarea id="q-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={input} />
                  <div className="flex flex-wrap gap-2">
                    {item.kind === "ATTACHMENT" && item.actions.canRescan && (
                      <button type="button" className={ghost} disabled={rescanMutation.isPending} onClick={() => rescanMutation.mutate(item.id)}>Rescan</button>
                    )}
                    <button type="button" className={btn} disabled={!item.actions.canRelease || !reasonOk} onClick={() => setPending("release")}>Release…</button>
                    <button type="button" className={ghost} disabled={!item.actions.canDelete || !reasonOk} onClick={() => setPending("reject")}>Reject…</button>
                    <button type="button" className={danger} disabled={!item.actions.canDelete || !reasonOk} onClick={() => setPending("delete")}>Delete…</button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">Releasing returns the message to its original mailbox for its members only. Reject and delete remove the stored content permanently (legal holds are respected).</p>
                </section>
              )}
              {error && <p role="alert" className="text-[11px] text-red-700 dark:text-red-300">{error}</p>}
              <section aria-labelledby="q-history-h">
                <h4 id="q-history-h" className="mb-1 text-[12px] font-semibold">Decision history</h4>
                {(item.decisions ?? []).length === 0 ? <p className="text-[11px] text-muted-foreground">No decisions recorded yet.</p> : (
                  <ol className="flex flex-col gap-1 text-[11px]">
                    {(item.decisions ?? []).map((d) => (
                      <li key={d.id} className="rounded border border-border p-1.5">
                        <span className="font-semibold">{d.decision.replace(/_/g, " ").toLowerCase()}</span> · {formatFullDate(d.createdAt)}
                        <p className="text-muted-foreground">{d.reason}</p>
                        {d.scanEvidence && typeof d.scanEvidence.to === "string" && <p className="text-muted-foreground">Scan: {String(d.scanEvidence.from)} → {String(d.scanEvidence.to)}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </PermissionBoundary>
      </aside>
      {pending && item && (
        <StepUpDialog
          purpose={PURPOSE[pending]}
          title={`${ACTION_LABEL[pending]} ${item.kind === "MESSAGE" ? "message" : item.filename ?? "attachment"}`}
          onCancel={() => setPending(null)}
          onVerified={async (stepUpId) => {
            const action = pending;
            setPending(null);
            try {
              await runAction(item, action, { reason: reason.trim(), stepUpId });
              setError(null);
              onChanged(action === "release" ? "Released to the original mailbox." : action === "reject" ? "Rejected. Stored content is being removed." : "Deleted. Stored content is being removed.");
              refresh();
              if (action !== "release") onClose();
            } catch (e) {
              setError(errorText(e));
            }
          }}
        />
      )}
    </div>
  );
}

export default function MailQuarantine({ canEdit }: { canEdit: boolean }) {
  const [kind, setKind] = useState<Kind>("messages");
  const [filters, setFilters] = useState({ category: "", source: "", organizationId: "", mailboxId: "", from: "", to: "" });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<{ id: string; kind: QuarantineItem["kind"] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];
  const query = {
    ...filters,
    from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : "",
    to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : "",
  };
  const list = useQuery({ queryKey: ["mail", "admin", "quarantine", "list", kind, query, cursor], queryFn: () => fetchList(kind, query, cursor), retry: false });
  const orgs = useQuery({ queryKey: ["mail", "admin", "organizations"], queryFn: adminApi.listOrganizations, retry: false });
  const mailboxes = useQuery({ queryKey: ["mail", "admin", "mailboxes"], queryFn: adminApi.listMailboxes, retry: false });
  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters({ ...filters, [key]: value });
    setCursors([null]);
  };
  const items = list.data?.items ?? [];
  return (
    <section className={card} aria-labelledby="mail-quarantine-h">
      <h3 id="mail-quarantine-h" className="text-[13px] font-semibold">Quarantine</h3>
      <p className="mb-2 text-[11px] text-muted-foreground">Held messages and files, metadata only. Content is never shown here. Infected content can never be released; release needs a clean scan and two-factor confirmation.</p>
      <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {(["messages", "attachments"] as Kind[]).map((value) => (
          <button key={value} type="button" aria-pressed={kind === value} onClick={() => { setKind(value); setCursors([null]); }} className={`rounded-[8px] border px-3 py-1 text-[12px] ${kind === value ? "border-primary bg-primary font-semibold text-white" : "border-border bg-card text-muted-foreground"}`}>
            {value === "messages" ? "Messages" : "Attachments"}
          </button>
        ))}
      </div>
      <form className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-6" onSubmit={(e) => e.preventDefault()} aria-label="Quarantine filters">
        <label className="text-[11px] text-muted-foreground">Reason
          <select value={filters.category} onChange={(e) => setFilter("category", e.target.value)} className={input}>
            <option value="">All reasons</option>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">Source
          <select value={filters.source} onChange={(e) => setFilter("source", e.target.value)} className={input}>
            <option value="">All</option>
            <option value="INBOUND">Received</option>
            <option value="OUTBOUND">Outgoing drafts</option>
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">Brand
          <select value={filters.organizationId} onChange={(e) => setFilter("organizationId", e.target.value)} className={input}>
            <option value="">All brands</option>
            {(orgs.data ?? []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">Mailbox
          <select value={filters.mailboxId} onChange={(e) => setFilter("mailboxId", e.target.value)} className={input}>
            <option value="">All mailboxes</option>
            {(mailboxes.data ?? []).map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">From
          <input type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} className={input} />
        </label>
        <label className="text-[11px] text-muted-foreground">To
          <input type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} className={input} />
        </label>
      </form>
      {msg && <p role="status" className="mb-2 text-[11px] text-emerald-800 dark:text-emerald-200">{msg}</p>}
      <PermissionBoundary isLoading={list.isLoading} error={list.error} retry={() => list.refetch()} compact forbiddenMessage={FORBIDDEN}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <caption className="sr-only">{kind === "messages" ? "Quarantined messages" : "Quarantined attachments"}</caption>
            <thead>
              <tr>
                {(kind === "messages" ? ["Received", "Mailbox", "Brand", "Sender", "Reason", "Size", "Files", ""] : ["Created", "Mailbox", "File", "Scan", "Reason", "Size", "Source", ""]).map((head) => <th key={head || "actions"} scope="col" className={th}>{head}</th>)}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={8} className={`${td} text-muted-foreground`}>Nothing is in quarantine for these filters.</td></tr>}
              {items.map((item) => (
                <tr key={item.id} className="border-t border-border">
                  <td className={td}>{formatFullDate(item.receivedAt || item.createdAt || "")}</td>
                  <td className={td}>{item.mailbox.name}</td>
                  {kind === "messages" ? (
                    <>
                      <td className={td}>{item.organization?.name ?? "—"}</td>
                      <td className={td}>{item.sender?.masked ?? "—"}</td>
                      <td className={td}><Category value={item.reasonCategory} /></td>
                      <td className={td}>{size(item.sizeBytes)}</td>
                      <td className={td}>{item.attachments?.length ?? 0}</td>
                    </>
                  ) : (
                    <>
                      <td className={td}>{item.filename}<span className="block text-[10px] text-muted-foreground">{item.contentType}</span></td>
                      <td className={td}>{item.scanStatus}{item.scanDetail ? <span className="block text-[10px] text-muted-foreground">{item.scanDetail}</span> : null}</td>
                      <td className={td}><Category value={item.reasonCategory} /></td>
                      <td className={td}>{size(item.sizeBytes)}</td>
                      <td className={td}>{item.source === "OUTBOUND_DRAFT" ? "Outgoing draft" : "Received"}</td>
                    </>
                  )}
                  <td className={td}>
                    <button type="button" className={ghost} onClick={() => setSelected({ id: item.id, kind: item.kind })} aria-label={`Review ${kind === "messages" ? `message from ${item.sender?.masked ?? "unknown sender"}` : item.filename}`}>Review</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" className={ghost} disabled={cursors.length < 2} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</button>
          <button type="button" className={ghost} disabled={!list.data?.nextCursor} onClick={() => list.data?.nextCursor && setCursors([...cursors, list.data.nextCursor])}>Next</button>
        </div>
      </PermissionBoundary>
      {selected && <Detail target={selected} canEdit={canEdit} onClose={() => setSelected(null)} onChanged={setMsg} />}
    </section>
  );
}
