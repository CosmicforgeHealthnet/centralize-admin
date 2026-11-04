"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useClientReady } from "@/lib/use-client-ready";
import { useRouter } from "next/navigation";
import { ArrowRight, MailPlus, Settings, ShieldAlert } from "lucide-react";
import MailState, { stateActionClass, stateSecondaryActionClass } from "@/components/mail/MailState";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import MailAwaitingActivation from "@/components/mail/MailAwaitingActivation";
import { classifyMailError } from "@/lib/mail.service";
import { useAuthStore } from "@/stores/auth.store";
import { useEntitlements } from "@/components/mail/hooks";

export default function MailHomePage() {
  const router = useRouter();
  const clientReady = useClientReady();
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
    <div className="rounded-xl border border-border bg-card shadow-[0_2px_12px_0_#0f172a04]">
      <PermissionBoundary isLoading={!clientReady || q.isLoading} error={q.error} retry={() => q.refetch()} loadingLabel="Loading mail">
        {q.data && !q.data.identityActive ? (
          <MailState icon={ShieldAlert} headingLevel={1} tone="access" role="alert" title="Mail access unavailable" description="Mail access is suspended because your account is not active. Contact your administrator for help." />
        ) : mailboxes.length === 0 ? (
          <MailState icon={MailPlus} headingLevel={1} tone="info" title="No mailbox assigned" description="Your account is not connected to a mailbox yet. Open Mail settings to request one, or contact your Mail administrator." actions={
            <>
              <Link href="/dashboard/mail/settings" className={stateActionClass}><Settings size={14} aria-hidden="true" />Mail settings &amp; requests</Link>
              {(q.data?.canManageDomains || q.data?.canViewAdministration) && <Link href="/dashboard/it?section=mail-admin" className={stateSecondaryActionClass}>Open Mail administration<ArrowRight size={14} aria-hidden="true" /></Link>}
            </>
          } />
        ) : (
          <p role="status" className="p-8 text-center text-xs text-muted-foreground">Opening {preferred?.name}…</p>
        )}
      </PermissionBoundary>
    </div>
  );
}
