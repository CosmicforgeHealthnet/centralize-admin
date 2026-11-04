"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileText, LayoutTemplate, Mail, Megaphone, Users } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { fetchAudiences, fetchCampaigns, fetchTemplates } from "@/lib/mail-marketing.service";
import type { MarketingOrganization } from "@/types/mail-marketing.types";
import AnalyticsFoundation from "./AnalyticsFoundation";
import OverviewSpendCard from "./OverviewSpendCard";
import { EmBadge, EmCard } from "./em-ui";
import { useOrgHref } from "./EmailMarketingShell";

export default function EmailMarketingOverview({ org }: { org: MarketingOrganization }) {
  const href = useOrgHref();
  const campaigns = useQuery({ queryKey: ["mail", "marketing", org.id, "campaigns", ""], queryFn: () => fetchCampaigns(org.id), gcTime: 300000, retry: false });
  const audiences = useQuery({ queryKey: ["mail", "marketing", org.id, "audiences"], queryFn: () => fetchAudiences(org.id), gcTime: 300000, retry: false });
  const templates = useQuery({ queryKey: ["mail", "marketing", org.id, "templates"], queryFn: () => fetchTemplates(org.id), gcTime: 300000, retry: false });
  const campaignRows = campaigns.data?.items ?? [];
  const audienceRows = audiences.data?.items ?? [];
  const templateRows = templates.data?.items ?? [];
  const metrics = [
    { label: "Campaigns", icon: Megaphone, count: campaignRows.length, query: campaigns, paged: Boolean(campaigns.data?.nextCursor) },
    { label: "Drafts", icon: FileText, count: campaignRows.filter(c => c.status === "DRAFT").length, query: campaigns, paged: Boolean(campaigns.data?.nextCursor) },
    { label: "Audiences", icon: Users, count: audienceRows.length, query: audiences, paged: Boolean(audiences.data?.nextCursor) },
    { label: "Templates", icon: LayoutTemplate, count: templateRows.length, query: templates, paged: Boolean(templates.data?.nextCursor) },
  ];
  return (
    <div className="min-w-0 space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {metrics.map(m => <section key={m.label} aria-label={m.label} className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-[0_2px_12px_0_#0f172a04]">
          <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-xs font-medium text-muted-foreground">{m.label}</h2><m.icon size={17} className="shrink-0 text-primary" aria-hidden="true" /></div>
          <PermissionBoundary isLoading={m.query.isLoading} error={m.query.error} compact>
            <p className="text-2xl font-semibold tracking-tight">{m.count}</p>
            <p className="mt-1 text-[10px] leading-5 text-muted-foreground">{m.paged ? "On the loaded page; more records available" : "Across this brand"}</p>
          </PermissionBoundary>
        </section>)}
      </div>
      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_290px]">
        <div className="min-w-0 space-y-5">
          <EmCard title="Recent campaigns" id="ov-campaigns" actions={<Link href={href("/campaigns")} className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">View all <ArrowRight size={13} /></Link>}>
            <PermissionBoundary isLoading={campaigns.isLoading} error={campaigns.error} compact>
              {campaignRows.length === 0 ? <div className="rounded-lg bg-muted/50 px-4 py-7 text-center"><Megaphone size={26} className="mx-auto mb-3 text-muted-foreground" /><p className="text-sm font-medium">No email campaigns yet</p><p className="mt-2 text-xs leading-6 text-muted-foreground">{org.canAuthor ? "Start a campaign draft from the Campaigns page." : "Campaigns for this brand will appear here."}</p>{org.canAuthor && <Link href={href("/campaigns")} className="mt-4 inline-block text-xs font-semibold text-primary">Open campaigns</Link>}</div> : <ul className="divide-y divide-border/60">{campaignRows.slice(0, 5).map(c => <li key={c.id}><Link href={href(`/campaigns/${c.id}`)} className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg px-2 py-4 transition hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary"><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-foreground">{c.name}</span><span className="mt-1 block text-[11px] text-muted-foreground">{c.topic}</span></span><EmBadge value={c.status} /><ArrowRight size={14} className="text-muted-foreground" /></Link></li>)}</ul>}
              {campaigns.data?.nextCursor && <p className="mt-3 text-[10px] text-muted-foreground">Showing the first page. Open Campaigns to load more.</p>}
            </PermissionBoundary>
          </EmCard>
          <EmCard title="Templates" id="ov-templates" actions={<Link href={href("/templates")} className="text-xs font-semibold text-primary">Browse templates</Link>}>
            <PermissionBoundary isLoading={templates.isLoading} error={templates.error} compact>
              {templateRows.length === 0 ? <p className="text-xs leading-6 text-muted-foreground">No branded templates yet. Create one in Templates.</p> : <div className="grid gap-3 sm:grid-cols-3">{templateRows.slice(0, 3).map(t => <Link key={t.id} href={href(`/templates/${t.id}`)} className="min-w-0 rounded-lg border border-border p-3 transition hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-primary"><LayoutTemplate size={19} className="mb-3 text-primary" /><p className="truncate text-xs font-semibold">{t.name}</p><p className="mt-1 text-[10px] text-muted-foreground">Open template</p></Link>)}</div>}
            </PermissionBoundary>
          </EmCard>
        </div>
        <div className="min-w-0 space-y-5">
          <EmCard title="Audiences" id="ov-audiences" actions={<Link href={href("/audiences")} className="text-xs font-semibold text-primary">Manage</Link>}>
            <PermissionBoundary isLoading={audiences.isLoading} error={audiences.error} compact>
              {audienceRows.length === 0 ? <p className="text-xs leading-6 text-muted-foreground">No audiences yet. Only contacts with recorded consent can be added.</p> : <ul className="divide-y divide-border/60">{audienceRows.slice(0, 5).map(a => <li key={a.id} className="flex items-start justify-between gap-3 py-3"><span className="min-w-0 text-xs font-medium">{a.name}</span><span className="shrink-0 text-[10px] text-muted-foreground">{a.contactCount != null ? `${a.contactCount.toLocaleString()} contacts` : a.topic}</span></li>)}</ul>}
            </PermissionBoundary>
          </EmCard>
          <section className="rounded-xl border border-primary/10 bg-primary/5 p-5"><Mail size={21} className="mb-3 text-primary" /><h2 className="text-sm font-semibold">Marketing shared mailbox</h2><p className="mt-2 text-xs leading-6 text-muted-foreground">Read and reply to individual emails in Mail. Your assigned mailboxes appear there.</p><Link href="/dashboard/mail" className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-primary">Open Mail <ArrowRight size={13} /></Link></section>
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2"><AnalyticsFoundation org={org} /><OverviewSpendCard org={org} /></div>
    </div>
  );
}
