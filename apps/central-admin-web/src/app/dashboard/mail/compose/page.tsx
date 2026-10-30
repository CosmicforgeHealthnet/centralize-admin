"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ComposeEditor from "@/components/mail/ComposeEditor";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { useEntitlements } from "@/components/mail/hooks";
import type { DraftMode } from "@/types/mail.types";

const MODES: DraftMode[] = ["NEW", "REPLY", "REPLY_ALL", "FORWARD"];

function ComposeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const entitlements = useEntitlements();
  const mailboxes = (entitlements.data?.mailboxes ?? []).filter((m) => m.canSend);
  const mailboxId = params.get("mailboxId") ?? mailboxes[0]?.id ?? null;
  const modeParam = params.get("mode") as DraftMode | null;
  const mode = modeParam && MODES.includes(modeParam) ? modeParam : "NEW";
  const back = mailboxId ? `/dashboard/mail/${mailboxId}` : "/dashboard/mail";

  return (
    <div className="mx-auto max-w-3xl">
      <PermissionBoundary isLoading={entitlements.isLoading} error={entitlements.error} retry={() => entitlements.refetch()}>
        {!mailboxId ? (
          <div role="alert" className="rounded-lg border border-border bg-card p-8 text-center text-xs text-muted-foreground">
            <p>You do not have a mailbox you can send from. A Mail administrator must grant you an active sender mailbox.</p>
            {(entitlements.data?.canManageDomains || entitlements.data?.canViewAdministration) && (
              <Link href="/dashboard/it?section=mail-admin" className="mt-3 inline-block rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground">
                Open Mail administration
              </Link>
            )}
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
