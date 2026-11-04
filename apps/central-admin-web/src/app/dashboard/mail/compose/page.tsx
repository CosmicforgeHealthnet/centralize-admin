"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useClientReady } from "@/lib/use-client-ready";
import { LockKeyhole } from "lucide-react";
import MailState, { stateActionClass } from "@/components/mail/MailState";
import ComposeEditor from "@/components/mail/ComposeEditor";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { useEntitlements } from "@/components/mail/hooks";
import type { DraftMode } from "@/types/mail.types";

const MODES: DraftMode[] = ["NEW", "REPLY", "REPLY_ALL", "FORWARD"];

function ComposeInner() {
  const router = useRouter();
  const clientReady = useClientReady();
  const params = useSearchParams();
  const entitlements = useEntitlements();
  const mailboxes = (entitlements.data?.mailboxes ?? []).filter((m) => m.canSend);
  const mailboxId = params.get("mailboxId") ?? mailboxes[0]?.id ?? null;
  const modeParam = params.get("mode") as DraftMode | null;
  const mode = modeParam && MODES.includes(modeParam) ? modeParam : "NEW";
  const back = mailboxId ? `/dashboard/mail/${mailboxId}` : "/dashboard/mail";

  return (
    <div className="mx-auto max-w-3xl">
      <PermissionBoundary isLoading={!clientReady || entitlements.isLoading} error={entitlements.error} retry={() => entitlements.refetch()} loadingLabel="Preparing draft">
        {!mailboxId ? (
          <div className="rounded-2xl border border-border bg-card">
            <MailState icon={LockKeyhole} tone="access" role="alert" title="No sending mailbox" description="Ask your Mail administrator for permission to send email." actions={
              (entitlements.data?.canManageDomains || entitlements.data?.canViewAdministration) ? <Link href="/dashboard/it?section=mail-admin" className={stateActionClass}>Open Mail administration</Link> : undefined
            } />
          </div>
        ) : (
          <ComposeEditor
            key={`${mailboxId}-${params.get("draftId") ?? "new"}`}
            mailboxId={mailboxId}
            draftId={params.get("draftId")}
            mode={mode}
            threadId={params.get("threadId")}
            inReplyToMessageId={params.get("messageId")}
            onClose={() => router.push(back)}
            onSent={(r) => router.push(`/dashboard/mail/${mailboxId}/thread/${r.threadId}?view=sent`)}
          />
        )}
      </PermissionBoundary>
    </div>
  );
}

export default function ComposePage() {
  return (
    <Suspense fallback={null}>
      <ComposeInner />
    </Suspense>
  );
}
