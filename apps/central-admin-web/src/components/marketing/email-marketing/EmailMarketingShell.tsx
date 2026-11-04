"use client";

import Link from "next/link";
import SectionNavigation from "../SectionNavigation";
import { useClientReady } from "@/lib/use-client-ready";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ArrowLeft, Building2, Megaphone } from "lucide-react";
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
    <div className="flex flex-col gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/dashboard/marketing" aria-label="Back to Marketing" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Email Marketing</h1>
            <p className="mt-1 text-xs text-muted-foreground">{title}</p>
          </div>
          {orgs.length > 1 && org && (
            <label className="flex w-full items-center gap-2 text-xs text-muted-foreground sm:ml-auto sm:w-auto">
              Brand
              <select
                value={org.id}
                onChange={(e) => router.push(`${pathname}?org=${e.target.value}`)}
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-sm text-foreground"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </label>
          )}
          {orgs.length === 1 && org && <span className="ml-auto text-[12px] text-muted-foreground">Brand: {org.name}</span>}
        </div>
        {!marketingDisabled && org && <div className="mt-5"><SectionNavigation label="Email marketing sections" value={TABS.slice().reverse().find(tab => tab.href ? pathname.startsWith(ROOT + tab.href) : pathname === ROOT)?.href ?? ""} groups={[{label: "Email Marketing", items: TABS.map(tab => ({value: tab.href, label: tab.label, href: href(tab.href)}))}]} onChange={value => router.push(href(value))} /></div>}
      </div>

      <PermissionBoundary
        isLoading={!clientReady || ent.isLoading || (!!ent.data?.marketingEnabled && orgsQ.isLoading)}
        error={ent.error || orgsQ.error}
        retry={() => {
          ent.refetch();
          orgsQ.refetch();
        }}
        forbiddenMessage="You do not have access to Email Marketing for this brand. Ask your administrator to review your access."
      >
        {marketingDisabled ? (
          <div className="rounded-xl border border-border bg-card"><MailState icon={Megaphone} tone="info" title="Email Marketing is not enabled" description="Email Marketing has not been activated for this environment yet. An administrator needs to complete setup before you can use campaigns and audiences." actions={<Link href="/dashboard/marketing" className={stateSecondaryActionClass}><ArrowLeft size={14} aria-hidden="true" />Back to Marketing</Link>} /></div>
        ) : !org ? (
          <div className="rounded-xl border border-border bg-card"><MailState icon={Building2} tone="access" title="No brand access" description="Marketing workspace access comes from your department. Ask HR to assign your brand under Accounts, Module Permissions, Mail Marketing." actions={<><button type="button" onClick={() => { ent.refetch(); orgsQ.refetch(); }} className={stateSecondaryActionClass}>Check again</button><Link href="/dashboard/marketing" className={stateSecondaryActionClass}><ArrowLeft size={14} aria-hidden="true" />Back to Marketing</Link></>} /></div>
        ) : (
          children(org, orgs)
        )}
      </PermissionBoundary>
    </div>
  );
}
