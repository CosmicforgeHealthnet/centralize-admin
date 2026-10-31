"use client";

// IT > Mail Administration > Sending permissions.
// This is staff/support external-send authorization, NOT Mail worker activation.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import StepUpDialog from "@/components/marketing/email-marketing/StepUpDialog";
import { classifyMailError } from "@/lib/mail.service";
import { listMailboxes } from "@/lib/mail-admin.service";
import { createRolloutRule, revokeRolloutRule, rolloutOverview } from "@/lib/mail-rollout.service";
import type { AdminMailbox } from "@/types/mail-admin.types";
import type { RolloutRule } from "@/types/mail-rollout.types";

const field = "w-full min-w-0 rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const action = "rounded-md bg-primary px-4 py-2 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";
const secondary = "rounded-md border border-border px-3 py-1.5 text-[12px] font-medium disabled:opacity-50";

type Pending = { title: string; execute: (stepUpId: string) => Promise<unknown> };
type Effect = "ALLOW" | "DENY";

function capabilityOf(mailbox: AdminMailbox): "STAFF_MAIL" | "SUPPORT" {
  return mailbox.purpose === "SUPPORT" ? "SUPPORT" : "STAFF_MAIL";
}

function ruleTarget(rule: RolloutRule, mailboxes: AdminMailbox[]): string {
  if (rule.scopeType === "MAILBOX") {
    const mailbox = mailboxes.find((entry) => entry.id === rule.scopeId);
    return mailbox ? mailbox.name + " (" + (mailbox.addresses[0]?.address ?? mailbox.id) + ")" : "Mailbox " + rule.scopeId;
  }
  if (rule.scopeType === "ENVIRONMENT") return "All mailboxes in " + rule.environment;
  return rule.scopeType.toLowerCase() + " " + rule.scopeId;
}

export default function MailSendingPermissions({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ["mail", "rollout", "overview"], queryFn: rolloutOverview, retry: false });
  const mailboxes = useQuery({ queryKey: ["mail", "admin", "mailboxes"], queryFn: listMailboxes, retry: false, enabled: canEdit });
  const [selectedMailboxId, setSelectedMailboxId] = useState("");
  const [effect, setEffect] = useState<Effect>("ALLOW");
  const [reason, setReason] = useState("Authorized mailbox sending");
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allMailboxes = mailboxes.data ?? [];
  const selectedId = selectedMailboxId || allMailboxes.find((box) => box.status === "ACTIVE")?.id || allMailboxes[0]?.id || "";
  const selected = allMailboxes.find((box) => box.id === selectedId);
  const capability = selected ? capabilityOf(selected) : "STAFF_MAIL";
  const rules = (overview.data?.rules ?? []).filter((rule) =>
    !rule.revokedAt && (rule.capability === "STAFF_MAIL" || rule.capability === "SUPPORT"),
  );
  const mailboxRules = rules.filter((rule) => rule.scopeType === "MAILBOX" && rule.scopeId === selectedId && rule.capability === capability);
  const isDenied = mailboxRules.some((rule) => rule.effect === "DENY");
  const isAllowed = mailboxRules.some((rule) => rule.effect === "ALLOW");

  async function refresh(): Promise<void> {
    await qc.invalidateQueries({ queryKey: ["mail", "rollout"] });
  }

  async function applyRule(): Promise<void> {
    if (!canEdit || !selected || selected.status !== "ACTIVE" || busy || reason.trim().length < 5) return;
    setMessage(null);
    const payload = {
      capability,
      scopeType: "MAILBOX",
      scopeId: selected.id,
      effect,
      reason: reason.trim(),
    };
    if (effect === "ALLOW") {
      setPending({
        title: "Authorize sending for " + selected.name,
        execute: (stepUpId) => createRolloutRule({ ...payload, stepUpId }),
      });
      return;
    }
    setBusy(true);
    try {
      await createRolloutRule(payload);
      await refresh();
      setMessage("Sending restriction applied to " + selected.name + ".");
    } catch (error) {
      setMessage(classifyMailError(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(rule: RolloutRule): Promise<void> {
    if (!canEdit || busy) return;
    setMessage(null);
    if (rule.effect === "DENY") {
      setPending({
        title: "Remove sending restriction",
        execute: (stepUpId) => revokeRolloutRule(rule.id, stepUpId),
      });
      return;
    }
    setBusy(true);
    try {
      await revokeRolloutRule(rule.id);
      await refresh();
      setMessage("Sending authorization removed.");
    } catch (error) {
      setMessage(classifyMailError(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-[14px] font-semibold">External email sending permissions</h3>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Authorize a specific active mailbox to send external mail. This does not activate background workers,
          grant mailbox membership, change sender identities or enable marketing campaigns.
        </p>
        <PermissionBoundary isLoading={overview.isLoading} error={overview.error} retry={() => overview.refetch()} compact>
          {overview.data && (
            <>
              {!overview.data.enforced && (
                <p role="status" className="mt-3 rounded-md border border-border bg-muted p-2 text-[12px]">
                  Sending rollout enforcement is off in this environment. Production permissions are enforced separately.
                </p>
              )}
              {canEdit && (
                <form className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void applyRule(); }}>
                  <label className="flex flex-col gap-1 text-[12px] font-medium">
                    Mailbox
                    <select className={field} value={selectedId} onChange={(event) => setSelectedMailboxId(event.target.value)} disabled={mailboxes.isLoading || busy}>
                      {allMailboxes.length === 0 && <option value="">No active mailboxes available</option>}
                      {allMailboxes.map((box) => (
                        <option key={box.id} value={box.id} disabled={box.status !== "ACTIVE"}>
                          {box.name} — {box.addresses[0]?.address ?? box.id}{box.status !== "ACTIVE" ? " (inactive)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] font-medium">
                    Action
                    <select className={field} value={effect} onChange={(event) => setEffect(event.target.value as Effect)} disabled={busy}>
                      <option value="ALLOW">Enable external sending (2FA required)</option>
                      <option value="DENY">Block external sending</option>
                    </select>
                  </label>
                  <div className="text-[12px] text-muted-foreground sm:col-span-2">
                    Sending purpose for this mailbox: <strong>{capability === "SUPPORT" ? "Support replies" : "Staff email"}</strong>.
                    {isDenied ? " An active mailbox DENY overrides an ALLOW." : isAllowed ? " A direct mailbox ALLOW rule is active." : " No direct mailbox rule is active."}
                  </div>
                  <label className="flex flex-col gap-1 text-[12px] font-medium sm:col-span-2">
                    Reason for change
                    <input className={field} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
                  </label>
                  <div className="sm:col-span-2">
                    <button className={action} type="submit" disabled={!selected || selected.status !== "ACTIVE" || reason.trim().length < 5 || busy || mailboxes.isLoading}>
                      {effect === "ALLOW" ? "Enable sending for this mailbox" : "Block sending for this mailbox"}
                    </button>
                  </div>
                  {mailboxes.error && <p role="alert" className="text-[12px] text-red-700 sm:col-span-2">{classifyMailError(mailboxes.error).message}</p>}
                </form>
              )}
              {!canEdit && <p className="mt-3 text-[12px] text-muted-foreground">Read-only. A Mail administrator with edit permission must authorize sending.</p>}
            </>
          )}
        </PermissionBoundary>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-[13px] font-semibold">Active staff and support sending rules</h3>
        <p className="mt-1 text-[12px] text-muted-foreground">Mailbox-specific rules are safest. Broader rules are shown for visibility, and an explicit DENY always takes priority.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-[12px]">
            <caption className="sr-only">Sending authorization and restrictions</caption>
            <thead><tr className="border-b border-border text-muted-foreground">
              <th className="py-2 pr-3">Permission</th><th className="pr-3">Scope</th><th className="pr-3">Effect</th><th className="pr-3">Reason</th><th className="sr-only">Actions</th>
            </tr></thead>
            <tbody>
              {!overview.isLoading && rules.length === 0 && <tr><td colSpan={5} className="py-3 text-muted-foreground">No active sending rules found.</td></tr>}
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-border">
                  <td className="py-2 pr-3">{rule.capability === "SUPPORT" ? "Support" : "Staff email"}</td>
                  <td className="pr-3">{ruleTarget(rule, allMailboxes)}</td>
                  <td className="pr-3 font-semibold">{rule.effect === "ALLOW" ? "Allowed" : "Blocked"}</td>
                  <td className="pr-3">{rule.reason}</td>
                  <td className="py-2 text-right">
                    {canEdit && <button type="button" className={secondary} disabled={busy} onClick={() => { void removeRule(rule); }}>Revoke</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {message && <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-[12px]">{message}</p>}
      {pending && (
        <StepUpDialog
          purpose="MAIL_ROLLOUT_CHANGE"
          title={pending.title}
          onCancel={() => setPending(null)}
          onVerified={async (stepUpId) => {
            const actionToApply = pending;
            setPending(null);
            try {
              await actionToApply.execute(stepUpId);
              await refresh();
              setMessage("Sending permission updated.");
            } catch (error) {
              setMessage(classifyMailError(error).message);
            }
          }}
        />
      )}
    </div>
  );
}
