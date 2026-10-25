"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
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
      <div className="rounded-[12px] border border-border bg-card px-4 pt-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/dashboard/marketing" aria-label="Back to Marketing" className="rounded p-1.5 hover:bg-muted">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="font-poppins text-[15px] font-semibold text-foreground">Email Marketing</h1>
            <p className="font-poppins text-[12px] text-muted-foreground">Marketing / Email Marketing / {title}</p>
          </div>
          {orgs.length > 1 && org && (
            <label className="ml-auto flex items-center gap-2 text-[12px] text-muted-foreground">
              Brand
              <select
                value={org.id}
                onChange={(e) => router.push(`${pathname}?org=${e.target.value}`)}
                className="rounded-md border border-border bg-card px-2 py-1 text-[12px] text-foreground"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </label>
          )}
          {orgs.length === 1 && org && <span className="ml-auto text-[12px] text-muted-foreground">Brand: {org.name}</span>}
        </div>
        <nav aria-label="Email marketing sections" className="mt-3 flex gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const target = `${ROOT}${t.href}`;
            const active = t.href === "" ? pathname === ROOT : pathname.startsWith(target);
            return (
              <Link
                key={t.label}
                href={href(t.href)}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap border-b-2 px-3 py-2 text-[12px] font-poppins ${active ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <PermissionBoundary
        isLoading={ent.isLoading || (!!ent.data?.marketingEnabled && orgsQ.isLoading)}
        error={ent.error || orgsQ.error}
        retry={() => {
          ent.refetch();
          orgsQ.refetch();
        }}
        forbiddenMessage="You do not have brand-scoped Email Marketing access."
      >
        {marketingDisabled ? (
          <div role="status" className="rounded-[12px] border border-border bg-card p-8 text-center">
            <h2 className="text-sm font-semibold">Email Marketing is not enabled</h2>
            <p className="mt-1 text-xs text-muted-foreground">The Marketing Email Studio is switched off for this environment (MAIL_MARKETING_ENABLED).</p>
          </div>
        ) : !org ? (
          <div role="status" className="rounded-[12px] border border-border bg-card p-8 text-center">
            <h2 className="text-sm font-semibold">No brand access</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              You have not been granted Email Marketing access for any brand. Ask an administrator for a brand-scoped grant.
            </p>
          </div>
        ) : (
          children(org, orgs)
        )}
      </PermissionBoundary>
    </div>
  );
}
