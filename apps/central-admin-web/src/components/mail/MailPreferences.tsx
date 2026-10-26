"use client";

// Personal Mail preferences (spec 15 "Profiles"): the preferred sender
// identity used when composing, and whether Mail sends you in-app "new email"
// notifications. Delivery failures and security notices are always sent.
// Signatures are per mailbox (see Signature below this section).

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { mailKeys, usePreferences } from "@/components/mail/hooks";
import { classifyMailError, updatePreferences, type MailPreferences as Prefs, type MailPreferencesInput } from "@/lib/mail.service";

const card = "rounded-lg border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";

function optionLabel(option: Prefs["senderOptions"][number]) {
  const who = option.displayName ? `${option.displayName} <${option.address}>` : option.address;
  return option.mailboxName ? `${who} (${option.mailboxName})` : who;
}

export default function MailPreferences() {
  const qc = useQueryClient();
  const prefs = usePreferences();
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (body: MailPreferencesInput) => updatePreferences(body),
    // Optimistic: the control reflects the choice at once; a refusal reloads.
    onMutate: (body) => {
      setMsg(null);
      qc.setQueryData<Prefs>(mailKeys.preferences, (old) => (old ? { ...old, ...body } : old));
    },
    onSuccess: (data) => {
      qc.setQueryData(mailKeys.preferences, data);
      setMsg({ text: "Preferences saved.", error: false });
    },
    onError: (e) => {
      const info = classifyMailError(e);
      const text = info.code === "MAIL_FEATURE_NOT_READY"
        ? "Preferences cannot be saved yet. Try again later."
        : info.code === "MAIL_SENDER_NOT_AUTHORIZED"
          ? "You are no longer approved to send as that address."
          : info.message;
      setMsg({ text, error: true });
      qc.invalidateQueries({ queryKey: mailKeys.preferences });
    },
  });
  const data = prefs.data;
  const disabled = !data?.available || save.isPending;
  return (
    <section className={card} aria-labelledby="prefs-h">
      <h2 id="prefs-h" className="mb-1 text-[13px] font-semibold">Preferences</h2>
      <p className="mb-2 text-[11px] text-muted-foreground">These apply to you in every mailbox.</p>
      <PermissionBoundary isLoading={prefs.isLoading} error={prefs.error} compact>
        {data && !data.available && (
          <p role="status" className="mb-2 text-[11px] text-muted-foreground">Preferences are not available yet. The defaults below are in effect.</p>
        )}
        <div className="flex flex-col gap-3">
          <div>
            <label htmlFor="pref-sender" className="text-[11px] text-muted-foreground">Default sender</label>
            <select
              id="pref-sender"
              aria-describedby="pref-sender-help"
              className={input}
              value={data?.defaultSenderAddressId ?? ""}
              disabled={disabled || !data?.senderOptions.length}
              onChange={(e) => save.mutate({ defaultSenderAddressId: e.target.value || null })}
            >
              <option value="">First address of each mailbox</option>
              {(data?.senderOptions ?? []).map((option) => (
                <option key={option.addressId} value={option.addressId}>{optionLabel(option)}</option>
              ))}
            </select>
            <p id="pref-sender-help" className="mt-1 text-[11px] text-muted-foreground">
              {data?.senderOptions.length
                ? "Pre-selected when you write from the mailbox that owns this address. You can still change it on each email."
                : "You have no approved sender addresses."}
            </p>
          </div>
          <div className="flex items-start gap-2">
            <input
              id="pref-notifications"
              type="checkbox"
              className="mt-0.5"
              aria-describedby="pref-notifications-help"
              checked={data?.notificationsEnabled ?? true}
              disabled={disabled}
              onChange={(e) => save.mutate({ notificationsEnabled: e.target.checked })}
            />
            <div>
              <label htmlFor="pref-notifications" className="text-[12px]">Notify me about new email</label>
              <p id="pref-notifications-help" className="text-[11px] text-muted-foreground">
                In-app notifications when email arrives in your mailboxes. Delivery failures and security notices are always sent.
              </p>
            </div>
          </div>
        </div>
        {msg && (
          <p role={msg.error ? "alert" : "status"} className={`mt-2 text-[11px] ${msg.error ? "text-red-600" : "text-muted-foreground"}`}>{msg.text}</p>
        )}
      </PermissionBoundary>
    </section>
  );
}
