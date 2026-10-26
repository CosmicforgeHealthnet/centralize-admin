"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import MailAwaitingActivation from "@/components/mail/MailAwaitingActivation";
import { classifyMailError } from "@/lib/mail.service";
import { useAuthStore } from "@/stores/auth.store";
import { useEntitlements } from "@/components/mail/hooks";

export default function MailHomePage() {
  const router = useRouter();
  const q = useEntitlements();
  const userTier = useAuthStore((state) => state.user?.tier);
  // Staging-only frontend-first shell: Mail APIs remain fail-closed until
  // secure backend activation. Never turn 401/403 or network errors into
  // an apparent empty mailbox, and never fabricate messages or identities.
  const showStagingWorkspace =
    process.env.NEXT_PUBLIC_STAGING_MAIL_NAV_ENABLED === "true" &&
    ["ADMIN", "EXECUTIVE", "SUPER"].includes(userTier ?? "") &&
    !!q.error && classifyMailError(q.error).code === "MAIL_DISABLED";
  const mailboxes = q.data?.mailboxes ?? [];
  const preferred = mailboxes.find((m) => m.type === "PERSONAL") ?? mailboxes[0];

  useEffect(() => {
    if (preferred) router.replace(`/dashboard/mail/${preferred.id}`);
  }, [preferred, router]);

  if (showStagingWorkspace) return <MailAwaitingActivation />;

  return (
    <div className="rounded-lg border border-border bg-card">
      <PermissionBoundary isLoading={q.isLoading} error={q.error} retry={() => q.refetch()} loadingLabel="Loading mail">
        {q.data && !q.data.identityActive ? (
          <div role="alert" className="p-8 text-center">
            <h1 className="text-sm font-semibold">Mail access unavailable</h1>
            <p className="mt-1 text-xs text-muted-foreground">Your account is not active, so mail access is suspended.</p>
          </div>
        ) : mailboxes.length === 0 ? (
          <div role="status" className="flex flex-col items-center gap-2 p-8 text-center">
            <Mail className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <h1 className="text-sm font-semibold">No mailbox assigned</h1>
            <p className="max-w-md text-xs text-muted-foreground">
              You do not have a CosmicForge mailbox yet. Ask your administrator, or request one below.
            </p>
            <div className="mt-2 flex gap-2">
              <Link href="/dashboard/mail/settings" className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground">
                Mail settings &amp; requests
              </Link>
            </div>
          </div>
        ) : (
          <p role="status" className="p-8 text-center text-xs text-muted-foreground">Opening {preferred?.name}…</p>
        )}
      </PermissionBoundary>
    </div>
  );
}
