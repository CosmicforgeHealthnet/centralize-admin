// src/components/marketing/campaigns/CampaignsPage.tsx
"use client";

import { useState, useEffect } from "react";
import { PlusCircle } from "lucide-react";
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
    updateCampaignStatus(id, "Archived" as any);
  };

  if (selectedId) {
    return <CampaignDetail campaignId={selectedId} onBack={handleBack} />;
  }

  if (isLoadingCampaigns && campaigns.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h2 className="font-poppins text-[14px] font-semibold text-foreground">Marketing — Campaigns</h2>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors w-fit"
        >
          New Campaign
          <PlusCircle className="w-3.5 h-3.5" />
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
              {String(value).padStart(2, "0")}
            </span>
            <span className="font-poppins text-[11px] text-muted-foreground text-center">{label}</span>
          </div>
        ))}
      </div>

      {campaigns.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 flex flex-col items-center justify-center">
          <p className="font-poppins text-[14px] text-muted-foreground">No campaigns found</p>
          <button
            onClick={() => setShowModal(true)}
            className="mt-4 text-primary hover:underline text-sm"
          >
            Create your first campaign
          </button>
        </div>
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