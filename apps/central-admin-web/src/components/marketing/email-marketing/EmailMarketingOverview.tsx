"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { fetchAudiences, fetchCampaigns, fetchTemplates } from "@/lib/mail-marketing.service";
import type { CampaignStatus, MarketingOrganization } from "@/types/mail-marketing.types";
import AnalyticsFoundation from "./AnalyticsFoundation";
import OverviewSpendCard from "./OverviewSpendCard";
import { EmBadge, EmCard } from "./em-ui";
import { useOrgHref } from "./EmailMarketingShell";

export default function EmailMarketingOverview({ org }: { org: MarketingOrganization }) {
  const href = useOrgHref();
  const campaigns = useQuery({ queryKey: ["mail", "marketing", org.id, "campaigns", ""], queryFn: () => fetchCampaigns(org.id), gcTime: 300000, retry: false });
  const audiences = useQuery({ queryKey: ["mail", "marketing", org.id, "audiences"], queryFn: () => fetchAudiences(org.id), gcTime: 300000, retry: false });
  const templates = useQuery({ queryKey: ["mail", "marketing", org.id, "templates"], queryFn: () => fetchTemplates(org.id), gcTime: 300000, retry: false });

  const byStatus = (campaigns.data?.items ?? []).reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});
  const order: CampaignStatus[] = ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "REJECTED", "SCHEDULED", "SENDING", "COMPLETE", "PARTIAL", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <EmCard title="Campaigns" id="ov-campaigns" actions={<Link href={href("/campaigns")} className="text-[12px] font-semibold text-primary">View all</Link>}>
        <PermissionBoundary isLoading={campaigns.isLoading} error={campaigns.error} compact>
          {(campaigns.data?.items ?? []).length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No email campaigns yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-3 text-[12px]">
              {order.map((s) => (
                <li key={s} className="flex items-center gap-1.5">
                  <EmBadge value={s} /> {byStatus[s] ?? 0}
                </li>
              ))}
            </ul>
          )}
          {campaigns.data?.nextCursor && <p className="mt-1 text-[10px] text-muted-foreground">Counts cover the first page of campaigns.</p>}
        </PermissionBoundary>
      </EmCard>
      <EmCard title="Audiences" id="ov-audiences" actions={<Link href={href("/audiences")} className="text-[12px] font-semibold text-primary">Manage</Link>}>
        <PermissionBoundary isLoading={audiences.isLoading} error={audiences.error} compact>
          {(audiences.data?.items ?? []).length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No audiences yet. Only contacts with recorded consent can be added.</p>
          ) : (
            <ul className="text-[12px]">
              {(audiences.data?.items ?? []).slice(0, 5).map((a) => (
                <li key={a.id} className="flex justify-between border-t border-border py-1">
                  <span>{a.name}</span>
                  <span className="text-muted-foreground">{a.contactCount != null ? `${a.contactCount} contacts` : a.topic}</span>
                </li>
              ))}
            </ul>
          )}
        </PermissionBoundary>
      </EmCard>
      <EmCard title="Templates" id="ov-templates" actions={<Link href={href("/templates")} className="text-[12px] font-semibold text-primary">Open editor</Link>}>
        <PermissionBoundary isLoading={templates.isLoading} error={templates.error} compact>
          <p className="text-[12px] text-muted-foreground">
            {(templates.data?.items ?? []).length === 0
              ? "No branded templates yet."
              : `${templates.data?.items.length}${templates.data?.nextCursor ? "+" : ""} branded template(s).`}
          </p>
        </PermissionBoundary>
      </EmCard>
      <AnalyticsFoundation org={org} />
      <OverviewSpendCard org={org} />
    </div>
  );
}
