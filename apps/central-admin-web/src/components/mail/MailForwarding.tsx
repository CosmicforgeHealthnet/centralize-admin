"use client";

// Forwarding requests for one mailbox. Every rule needs approval by a mail
// administrator (external addresses also need an allowed domain and MFA);
// the owner can turn forwarding off at any time.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError, disableForwarding, fetchForwarding, requestForwarding } from "@/lib/mail.service";
import type { ForwardingRule, MailboxSummary } from "@/types/mail.types";

const card = "rounded-lg border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";

const STATUS_LABEL: Record<ForwardingRule["status"], string> = {
  PENDING_APPROVAL: "Waiting for approval",
  ACTIVE: "Active",
  REJECTED: "Rejected",
  DISABLED: "Off",
};

const NOT_ALLOWED: Record<string, string> = {
  EXTERNAL_DOMAIN_NOT_ALLOWED: "Forwarding to that domain is not allowed by company policy.",
  UNPROVISIONED_LOCAL_ADDRESS: "That company address does not exist.",
  TARGET_NOT_ACTIVE: "That address is not active.",
  SAME_MAILBOX: "That address already belongs to this mailbox.",
};

export default function MailForwarding({ mailbox }: { mailbox: MailboxSummary }) {
  const qc = useQueryClient();
  const canManage = mailbox.type === "PERSONAL" ? mailbox.role === "OWNER" : mailbox.role === "OWNER" || mailbox.role === "MANAGER";
  const key = ["mail", "forwarding", mailbox.id];
  const rules = useQuery({ queryKey: key, queryFn: () => fetchForwarding(mailbox.id), enabled: canManage, retry: false, gcTime: 5 * 60 * 1000 });
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const onError = (e: unknown) => {
    const info = classifyMailError(e);
    const reasonCode = typeof info.detail?.reason === "string" ? info.detail.reason : "";
    setMsg(NOT_ALLOWED[reasonCode] ?? (info.code === "MAIL_FEATURE_NOT_READY" ? "Forwarding is not available yet." : info.message));
  };
  const submit = useMutation({
    mutationFn: () => requestForwarding(mailbox.id, { targetAddress: target.trim(), reason: reason.trim() }),
    onSuccess: () => { setTarget(""); setReason(""); setMsg("Request sent. A mail administrator must approve it before anything is forwarded."); qc.invalidateQueries({ queryKey: key }); },
    onError,
  });
  const disable = useMutation({
    mutationFn: (id: string) => disableForwarding(id),
    onSuccess: () => { setMsg("Forwarding turned off."); qc.invalidateQueries({ queryKey: key }); },
    onError,
  });
  if (!canManage) return null;
  return (
    <section className={card} aria-labelledby={`fwd-h-${mailbox.id}`}>
      <h2 id={`fwd-h-${mailbox.id}`} className="mb-1 text-[13px] font-semibold">Forwarding</h2>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Approved forwarding sends a copy of new mail. You keep the original. Quarantined mail and unscanned attachments are never forwarded, and forwarding stops automatically if the mailbox is suspended.
      </p>
      <PermissionBoundary isLoading={rules.isLoading} error={rules.error} compact>
        <ul className="mb-3 text-[12px]">
          {(rules.data ?? []).length === 0 && <li className="text-muted-foreground">No forwarding.</li>}
          {(rules.data ?? []).map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-2 border-t border-border py-1">
              <span className="flex-1 break-all">{rule.targetAddress} <span className="text-muted-foreground">({rule.targetKind === "EXTERNAL" ? "external" : "company"})</span></span>
              <span className="font-semibold">{STATUS_LABEL[rule.status]}</span>
              {rule.lastForwardedAt && <span className="text-muted-foreground">last {formatFullDate(rule.lastForwardedAt)}</span>}
              {(rule.status === "ACTIVE" || rule.status === "PENDING_APPROVAL") && (
                <button type="button" className="text-red-600 hover:underline disabled:opacity-50" disabled={disable.isPending} onClick={() => disable.mutate(rule.id)}>
                  Turn off
                </button>
              )}
            </li>
          ))}
        </ul>
        <form className="grid grid-cols-1 gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (target.trim() && reason.trim().length >= 5) submit.mutate(); }}>
          <label className="text-[11px] text-muted-foreground">Forward to
            <input type="email" value={target} onChange={(e) => setTarget(e.target.value)} className={input} placeholder="name@example.com" />
          </label>
          <label className="text-[11px] text-muted-foreground">Business reason
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={input} placeholder="Why is forwarding needed?" />
          </label>
          <button type="submit" className={`${btn} justify-self-start`} disabled={!target.trim() || reason.trim().length < 5 || submit.isPending}>Request forwarding</button>
        </form>
      </PermissionBoundary>
      {msg && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}
