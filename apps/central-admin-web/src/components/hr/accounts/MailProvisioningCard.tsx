"use client";

// HR > Accounts: request a CosmicForge Mail mailbox for this employee during
// onboarding (spec §15, §24). HR only raises the request; a mail
// administrator in IT approves it, and approval creates the mailbox. The card
// hides itself when Mail is off or the viewer has no Mail access at all, so HR
// screens are unchanged for environments without Mail.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEntitlements } from "@/components/mail/hooks";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import { createProvisionRequest, listProvisionRequests } from "@/lib/mail-admin.service";

const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] font-poppins outline-none focus:border-primary";

const STATUS_TEXT: Record<string, string> = {
  PENDING: "Waiting for IT approval",
  PROVISIONED: "Mailbox created",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

function explain(error: unknown) {
  const info = classifyMailError(error);
  const reason = info.detail?.reason as string | undefined;
  if (reason === "DOMAIN_NOT_REGISTERED") return "That address's domain is not registered with CosmicForge Mail. Ask IT to add the domain first.";
  if (info.detail?.field === "requestedAddress") return "Enter a full email address, for example ada.okafor@cosmicforge.com.";
  if (info.detail?.field === "subjectAdminUserId") return "This account cannot receive a mailbox right now.";
  return info.message;
}

export default function MailProvisioningCard({ accountId, accountName }: { accountId: string; accountName: string }) {
  const qc = useQueryClient();
  const ents = useEntitlements();
  const enabled = Boolean(ents.data?.mailEnabled && ents.data?.canProvision);
  const requests = useQuery({ queryKey: ["mail", "provisioning", "hr"], queryFn: listProvisionRequests, enabled, retry: false });
  const [address, setAddress] = useState("");
  const [justification, setJustification] = useState("");
  const create = useMutation({
    mutationFn: () => createProvisionRequest({ type: "PERSONAL_MAILBOX", requestedAddress: address.trim(), subjectAdminUserId: accountId, justification: justification.trim() || undefined }),
    onSuccess: () => {
      setAddress("");
      setJustification("");
      qc.invalidateQueries({ queryKey: ["mail", "provisioning"] });
    },
  });

  if (!enabled) return null;
  const mine = (requests.data ?? []).filter((r) => r.subjectAdminUserId === accountId && r.type === "PERSONAL_MAILBOX");
  const open = mine.some((r) => r.status === "PENDING");

  return (
    <section className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3" aria-labelledby="hr-mail-provisioning-h">
      <div>
        <h3 id="hr-mail-provisioning-h" className="font-poppins text-[13px] font-semibold text-foreground">Work email (CosmicForge Mail)</h3>
        <p className="font-poppins text-[11px] text-muted-foreground">Request a mailbox for {accountName}. IT reviews and creates it; HR cannot open employees&apos; mail.</p>
      </div>
      {requests.error ? (
        <p role="alert" className="font-poppins text-[11px] text-red-700 dark:text-red-300">{explain(requests.error)}</p>
      ) : mine.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {mine.map((r) => (
            <li key={r.id} className="font-poppins text-[12px]">
              <span className="font-semibold break-all">{r.requestedAddress}</span> · {STATUS_TEXT[r.status] ?? r.status}
              <span className="block text-[10px] text-muted-foreground">Requested {formatFullDate(r.createdAt)}{r.reviewNote ? ` · IT note: ${r.reviewNote}` : ""}</span>
            </li>
          ))}
        </ul>
      ) : (
        !requests.isLoading && <p className="font-poppins text-[11px] text-muted-foreground">No mailbox has been requested from this screen yet.</p>
      )}
      {!open && (
        <form className="flex flex-col gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <label htmlFor="hr-mail-address" className="font-poppins text-[11px] font-semibold text-foreground">Requested address</label>
          <input id="hr-mail-address" type="email" className={input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="first.last@cosmicforge.com" required />
          <label htmlFor="hr-mail-justification" className="font-poppins text-[11px] font-semibold text-foreground">Note for IT (optional)</label>
          <input id="hr-mail-justification" className={input} value={justification} onChange={(e) => setJustification(e.target.value)} maxLength={500} />
          {create.error ? <p role="alert" className="font-poppins text-[11px] text-red-700 dark:text-red-300">{explain(create.error)}</p> : null}
          {create.isSuccess ? <p role="status" className="font-poppins text-[11px] text-emerald-700 dark:text-emerald-300">Request sent to IT.</p> : null}
          <button type="submit" disabled={create.isPending || !address.trim()} className="h-[38px] rounded-xl bg-primary text-white text-[12px] font-poppins font-semibold hover:bg-primary/90 disabled:opacity-50">
            {create.isPending ? "Sending…" : "Request mailbox"}
          </button>
        </form>
      )}
    </section>
  );
}
