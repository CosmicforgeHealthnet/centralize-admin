"use client";

import { useEffect, useState } from "react";
import { useMarketingIntelligenceStore } from "@/stores/marketing-intelligence.store";
import ProviderBadge, { BadgeProvider } from "../shared/ProviderBadge";
import StatusChip from "../shared/StatusChip";
import EmptyState from "../shared/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import type { MIPlatform } from "@/types/marketing-intelligence.types";

const ALL_PLATFORMS: MIPlatform[] = ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];

const today = new Date().toISOString().slice(0, 10);
const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

export default function SyncHealthPage() {
  const {
    lastSyncResult, isSyncing, runSync,
    providerValidation, isLoadingProviderValidation, fetchProviderValidation,
    error, clearError,
  } = useMarketingIntelligenceStore();

  const [selectedPlatforms, setSelectedPlatforms] = useState<MIPlatform[]>(ALL_PLATFORMS);
  const [since, setSince] = useState(threeDaysAgo);
  const [until, setUntil] = useState(today);

  useEffect(() => {
    fetchProviderValidation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) {
      const t = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(t);
    }
  }, [error, clearError]);

  const togglePlatform = (platform: MIPlatform) => {
    setSelectedPlatforms((prev) =>
      prev.includes(platform) ? prev.filter((p) => p !== platform) : [...prev, platform]
    );
  };

  const handleRunSync = () => {
    runSync({ platforms: selectedPlatforms, connectionIds: [], since, until });
  };

  return (
    <div className="flex flex-col gap-4 w-full max-w-full overflow-x-hidden px-1 sm:px-0">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins break-words">
          {error}
        </div>
      )}

      <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-4 shadow-sm">
        <p className="font-poppins text-[13px] font-semibold text-foreground">Run manual sync</p>

        <div className="flex flex-wrap gap-2">
          {ALL_PLATFORMS.map((platform) => {
            const selected = selectedPlatforms.includes(platform);
            return (
              <button
                key={platform}
                onClick={() => togglePlatform(platform)}
                className={`rounded-lg border px-1.5 py-1 transition-all duration-150 ${
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border opacity-50 hover:opacity-75"
                }`}
              >
                <ProviderBadge provider={platform as BadgeProvider} size="sm" />
              </button>
            );
          })}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="min-w-0 flex-1 sm:flex-none font-poppins text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground"
            />
            <span className="font-poppins text-[11px] text-muted-foreground shrink-0">to</span>
            <input
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="min-w-0 flex-1 sm:flex-none font-poppins text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground"
            />
          </div>
          <button
            onClick={handleRunSync}
            disabled={isSyncing || selectedPlatforms.length === 0}
            className="font-poppins text-[12px] font-medium bg-primary text-primary-foreground px-4 py-2 sm:py-1.5 rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90 w-full sm:w-auto sm:ml-auto shrink-0"
          >
            {isSyncing ? "Running…" : "Run sync"}
          </button>
        </div>
      </div>

      {isSyncing && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[90px] rounded-xl" />)}
        </div>
      )}

      {!isSyncing && lastSyncResult && (
        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <p className="font-poppins text-[13px] font-semibold text-foreground">Last sync result</p>
            <span className="font-poppins text-[11px] text-muted-foreground">
              {new Date(lastSyncResult?.startedAt).toLocaleString()}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {lastSyncResult?.results?.map((r) => (
              <div
                key={`${r.platform}-${r.connectionId}`}
                className="border border-border rounded-lg p-3 flex flex-col gap-2 min-w-0"
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="min-w-0">
                    <ProviderBadge provider={r.platform as BadgeProvider} subtitle={r.accountLabel ?? undefined} size="sm" />
                  </div>
                  <StatusChip status={r.status} />
                </div>
                {r.status === "SUCCESS" || r.status === "PARTIAL" ? (
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 font-poppins text-[11px] text-muted-foreground">
                    <span>Fetched: {r.fetched}</span>
                    <span>Inserted: {r.inserted}</span>
                    <span>Updated: {r.updated}</span>
                    <span>Failed: {r.failed}</span>
                  </div>
                ) : (
                  <p className="font-poppins text-[11px] text-red-500 break-words">
                    {r.error ?? "No credentials configured"}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-card rounded-xl border border-border p-4 shadow-sm">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Provider validation status</p>
        {isLoadingProviderValidation ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
          </div>
        ) : providerValidation.length === 0 ? (
          <EmptyState message="No provider validation data available" />
        ) : (
          <div className="flex flex-col gap-2">
            {providerValidation.map((row) => (
              <div
                key={row.platform}
                className="flex flex-wrap items-center justify-between gap-2 border border-border rounded-lg p-3"
              >
                <ProviderBadge provider={row.platform as BadgeProvider} size="sm" />
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  <StatusChip status={row.liveStatus} />
                  {row.liveStatus !== "LIVE_VALIDATED" && row.blocker && (
                    <span className="font-poppins text-[10px] text-muted-foreground">
                      {row.blocker.replace(/_/g, " ").toLowerCase()}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}