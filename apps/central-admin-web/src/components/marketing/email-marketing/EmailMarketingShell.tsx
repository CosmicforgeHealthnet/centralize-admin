"use client";

import Link from "next/link";
import SectionNavigation from "../SectionNavigation";
import { useClientReady } from "@/lib/use-client-ready";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ChevronLeft, LockKeyhole, Megaphone } from "lucide-react";
import MailState, { stateSecondaryActionClass } from "@/components/mail/MailState";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { useEntitlements } from "@/components/mail/hooks";
import { fetchMarketingOrganizations } from "@/lib/mail-marketing.service";
import type { MarketingOrganization } from "@/types/mail-marketing.types";

const TABS = [
  { label: "Overview", href: "" },
  { label: "Campaigns", href: "/campaigns" },
  { label: "Audiences", href: "/audiences" },
  { label: "Contacts & consent", href: "/contacts" },
  { label: "Templates", href: "/templates" },
  { label: "Automation", href: "/automation" },
  { label: "Settings", href: "/settings" },
];
const ROOT = "/dashboard/marketing/email-marketing";

export function useOrgHref() {
  const params = useSearchParams();
  const org = params.get("org");
  return (path: string) => `${ROOT}${path}${org ? `?org=${org}` : ""}`;
}

export default function EmailMarketingShell({
  title,
  children,
}: {
  title: string;
  children: (org: MarketingOrganization, orgs: MarketingOrganization[]) => ReactNode;
}) {
  const router = useRouter();
  const clientReady = useClientReady();
  const pathname = usePathname();
  const params = useSearchParams();
  const ent = useEntitlements();
  const orgsQ = useQuery({
    queryKey: ["mail", "marketing", "organizations"],
    queryFn: fetchMarketingOrganizations,
    gcTime: 5 * 60 * 1000,
    retry: false,
    enabled: !!ent.data?.marketingEnabled,
  });
  const orgs = orgsQ.data ?? [];
  const org = orgs.find((o) => o.id === params.get("org")) ?? orgs[0];
  const href = useOrgHref();

  const marketingDisabled = ent.data && !ent.data.marketingEnabled;

  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/dashboard/marketing" aria-label="Back to Marketing" className="mb-2 inline-flex min-h-9 items-center gap-1 -ml-1 rounded-md pr-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />Marketing
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Email Marketing</h1>
        </div>
        {orgs.length > 1 && org ? (
          <label className="flex w-full items-center gap-3 text-sm text-muted-foreground sm:w-auto">
            Brand
            <select value={org.id} onChange={event => router.push(`${pathname}?org=${event.target.value}`)} className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-sm text-foreground sm:min-w-44">
              {orgs.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        ) : org ? <span className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">{org.name}</span> : null}
      </header>
      <div className="flex min-w-0 flex-col gap-6 min-[1200px]:flex-row min-[1200px]:items-start">
        {!marketingDisabled && org && (
          <SectionNavigation sidebar label="Email marketing sections" value={TABS.slice().reverse().find(tab => tab.href ? pathname.startsWith(ROOT + tab.href) : pathname === ROOT)?.href ?? ""} groups={[{ label: "Email Marketing", items: TABS.map(tab => ({ value: tab.href, label: tab.label, href: href(tab.href) })) }]} onChange={value => router.push(href(value))} />
        )}
        <div className="min-w-0 flex-1" aria-label={`${title} content`}>
          <PermissionBoundary isLoading={!clientReady || ent.isLoading || (!!ent.data?.marketingEnabled && orgsQ.isLoading)} error={ent.error || orgsQ.error} retry={() => { ent.refetch(); orgsQ.refetch(); }} forbiddenMessage="Ask your administrator for access to this marketing brand.">
            {marketingDisabled ? (
              <div className="rounded-2xl border border-border bg-card"><MailState icon={Megaphone} tone="info" title="Email Marketing is not enabled" description="An administrator needs to activate Email Marketing before you can use it." /></div>
            ) : !org ? (
              <div className="rounded-2xl border border-border bg-card"><MailState icon={LockKeyhole} tone="access" title="No brand access" description="Ask your administrator to assign a marketing brand to your account." actions={<button type="button" onClick={() => { ent.refetch(); orgsQ.refetch(); }} className={stateSecondaryActionClass}>Check again</button>} /></div>
            ) : children(org, orgs)}
          </PermissionBoundary>
        </div>
      </div>
    </div>
  );
}
