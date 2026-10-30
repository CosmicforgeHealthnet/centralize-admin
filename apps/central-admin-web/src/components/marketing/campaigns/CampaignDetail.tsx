// src/components/marketing/campaigns/CampaignDetail.tsx
"use client";

import { useState, useEffect } from "react";
import { ArrowLeft, Users, MousePointerClick, TrendingUp, CreditCard, TrendingDown } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import type { CampaignDetail as CampaignDetailType } from "@/types/marketing.types";
import EditCampaignModal from "./EditCampaignModal";

const TABS = ["Overview", "Performance", "Timeline", "Team"] as const;
type Tab = (typeof TABS)[number];

interface Props {
  campaignId: string;
  onBack: () => void;
}

export default function CampaignDetail({ campaignId, onBack }: Props) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [showEditModal, setShowEditModal] = useState(false);
const {
  selectedCampaign,
  campaignTimeline,
  campaignTeam,
  isLoadingCampaignDetail,
  fetchCampaignDetail,
  updateCampaignStatus,
  actionLoading,
  error,
} = useMarketingStore();

  useEffect(() => {
    if (campaignId) {
      fetchCampaignDetail(campaignId);
    }
  }, [campaignId, fetchCampaignDetail]);

  if (isLoadingCampaignDetail || !selectedCampaign) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[200px] w-full rounded-xl" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[90px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-[200px] rounded-xl" />
          <Skeleton className="h-[200px] rounded-xl" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <p className="text-red-500 text-sm">{error}</p>
        <button onClick={onBack} className="mt-4 text-primary hover:underline">
          Go back
        </button>
      </div>
    );
  }

  const campaign = selectedCampaign;

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Campaigns</span>
      </button>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-poppins text-[16px] font-semibold text-foreground">{campaign.title}</h2>
          <span className="font-poppins text-[12px] font-semibold text-green-500">{campaign.status}</span>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-poppins font-semibold bg-primary/8 text-primary">
            {campaign.type}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <button
  onClick={() => setShowEditModal(true)}
  className="px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors"
>
  Edit Campaign
</button>
<button
  onClick={() => updateCampaignStatus(campaignId, campaign.status === "Active" ? "Paused" : "Active")}
  disabled={actionLoading === campaignId}
  className="px-4 py-2 bg-foreground text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-foreground/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
>
  {actionLoading === campaignId
    ? "Updating..."
    : campaign.status === "Active" ? "Pause Campaign" : "Launch Campaign"}
</button>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="font-poppins text-[13px] font-semibold text-foreground">Budget</span>
        </div>
        <p className="font-poppins text-[13px] text-foreground mb-3">
          {campaign.budget ? `$${campaign.budget.toLocaleString()}` : "—"}
        </p>
        <div className="flex items-center justify-between mb-1">
          <span className="font-poppins text-[11px] text-muted-foreground">Campaign Progress</span>
          <span className="font-poppins text-[11px] text-muted-foreground">{campaign.progress}%</span>
        </div>
        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden mb-2">
          <div className="h-full bg-foreground rounded-full" style={{ width: `${campaign.progress}%` }} />
        </div>
        <div className="flex items-center justify-between">
          <span className="font-poppins text-[11px] text-muted-foreground">
            Started: {campaign.startedAt || "—"}
          </span>
          <span className="font-poppins text-[11px] text-muted-foreground">
            Est. Completion: {campaign.estCompletion || "—"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { icon: Users, label: "Total Reach", value: campaign.stats?.totalReach || "—", up: true },
          { icon: MousePointerClick, label: "Engagement Rate", value: campaign.stats?.engagementRate || "—", up: false },
          { icon: TrendingUp, label: "Conversion Rate", value: campaign.stats?.conversionRate || "—", up: true },
          { icon: CreditCard, label: "Cost Per Click", value: campaign.stats?.costPerClick || "—", up: false },
        ].map(({ icon: Icon, label, value, up }) => (
          <div key={label} className="bg-card rounded-xl border border-border p-4 flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <Icon className="w-3.5 h-3.5 text-primary" />
              </div>
              
            </div>
            <span className="font-poppins text-[18px] font-bold text-foreground">{value}</span>
            <span className="font-poppins text-[11px] text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1 bg-muted rounded-lg p-1 w-fit overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-md text-[12px] font-poppins font-semibold whitespace-nowrap transition-colors ${
              tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-card rounded-xl border border-border p-4">
            <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-2">Campaign Overview</h3>
            <p className="font-poppins text-[12px] text-muted-foreground leading-relaxed">
              {campaign.overview || "No overview provided."}
            </p>
          </div>
          <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">Campaign Details</h3>
            {[
              { label: "Target Audience", value: campaign.targetAudience || "—" },
              { label: "Duration", value: campaign.duration || "—" },
              { label: "Budget", value: campaign.budget ? `$${campaign.budget.toLocaleString()}` : "—" },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="font-poppins text-[12px] font-medium text-foreground">{label}</span>
                <span className="font-poppins text-[12px] text-muted-foreground">{value}</span>
              </div>
            ))}
            <div className="flex flex-col gap-1.5">
              <span className="font-poppins text-[12px] font-medium text-foreground">Channels</span>
              <div className="flex flex-wrap gap-2">
                {campaign.channels && campaign.channels.length > 0 ? (
                  campaign.channels.map((c) => (
                    <span
                      key={c}
                      className="px-2.5 py-1 border border-border rounded-full text-[10px] font-poppins text-foreground"
                    >
                      {c}
                    </span>
                  ))
                ) : (
                  <span className="text-muted-foreground text-sm">No channels specified</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "Performance" && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { label: "Opens", value: campaign.stats?.totalReach || "—" },
            { label: "Clicks", value: campaign.stats?.engagementRate || "—" },
            { label: "Conversions", value: campaign.stats?.conversionRate || "—" },
          ].map(({ label, value }) => (
            <div key={label} className="bg-card rounded-xl border border-border p-6 flex flex-col items-center justify-center gap-1">
              <span className="font-poppins text-[24px] font-bold text-foreground">{value}</span>
              <span className="font-poppins text-[12px] text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "Timeline" && (
        <div className="bg-card rounded-xl border border-border p-4">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-3">Campaign Timeline</h3>
          <div className="flex flex-col gap-3">
            {campaignTimeline.length > 0 ? (
              campaignTimeline.map((item) => (
                <div key={item.label} className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${item.done ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                    <span className="font-poppins text-[12px] text-foreground">{item.label}</span>
                  </div>
                  <span className="font-poppins text-[11px] text-muted-foreground">{item.date || "—"}</span>
                </div>
              ))
            ) : (
              <div className="text-center text-muted-foreground text-sm py-4">No timeline events</div>
            )}
          </div>
        </div>
      )}

      {tab === "Team" && (
        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Campaign Team</h3>
          {campaignTeam.length > 0 ? (
            campaignTeam.map((member) => (
              <div key={member.id} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="font-poppins text-[12px] font-bold text-primary">{member.name.charAt(0)}</span>
                </div>
                <div className="flex flex-col">
                  <span className="font-poppins text-[12px] font-semibold text-foreground">{member.name}</span>
                  <span className="font-poppins text-[11px] text-muted-foreground">{member.role}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="text-center text-muted-foreground text-sm py-4">No team members assigned</div>
          )}
        </div>
      )}

      {showEditModal && (
  <EditCampaignModal campaign={campaign} onClose={() => setShowEditModal(false)} />
)}
    </div>
  );
}