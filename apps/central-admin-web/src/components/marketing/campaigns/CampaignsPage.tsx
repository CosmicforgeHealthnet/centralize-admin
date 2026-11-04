// src/components/marketing/campaigns/CampaignsPage.tsx
"use client";

import { useState, useEffect } from "react";
import MailState from "@/components/mail/MailState";
import { Megaphone, Plus } from "lucide-react";
import CampaignCard from "./CampaignCard";
import CreateCampaignModal from "./CreateCampaignModal";
import CampaignDetail from "./CampaignDetail";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";

export default function CampaignsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  const {
    campaigns,
    campaignStats,
    campaignFilters,
    isLoadingCampaigns,
    error,
    fetchCampaigns,
    setCampaignFilters,
    deleteCampaign,
    duplicateCampaign,
    updateCampaignStatus,
    clearError,
  } = useMarketingStore();

  useEffect(() => {
    fetchCampaigns();
  }, [campaignFilters, fetchCampaigns]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  const handleView = (id: string) => setSelectedId(id);
  const handleBack = () => setSelectedId(null);

  // Handle archive - pass Archived status
  const handleArchive = (id: string) => {
    updateCampaignStatus(id, "Archived");
  };

  if (selectedId) {
    return <CampaignDetail campaignId={selectedId} onBack={handleBack} />;
  }

  if (isLoadingCampaigns && campaigns.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-36 rounded-lg" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[90px] rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[200px] rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3">
        <button
          onClick={() => setShowModal(true)}
          className="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />New campaign
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Total Campaigns", value: campaignStats?.total || 0 },
          { label: "Active campaigns", value: campaignStats?.active || 0 },
          { label: "Drafts", value: campaignStats?.drafts || 0 },
          { label: "Campaigns Completed", value: campaignStats?.completed || 0 },
        ].map(({ label, value }) => (
          <div key={label} className="bg-card rounded-xl border border-border p-5 flex flex-col items-center justify-center gap-1">
            <span className="font-poppins text-[26px] font-bold text-foreground">
              {value}
            </span>
            <span className="font-poppins text-[11px] text-muted-foreground text-center">{label}</span>
          </div>
        ))}
      </div>

      {campaigns.length === 0 ? (
        <div className="rounded-xl border border-border bg-card"><MailState icon={Megaphone} title="No campaigns found" description="Create a campaign to get started." /></div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {campaigns.map((c) => (
            <CampaignCard
              key={c.id}
              campaign={c}
              onView={handleView}
              onDuplicate={duplicateCampaign}
              onDelete={deleteCampaign}
              onStatusChange={updateCampaignStatus}
              onArchive={handleArchive}
            />
          ))}
        </div>
      )}

      {showModal && (
        <CreateCampaignModal onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}