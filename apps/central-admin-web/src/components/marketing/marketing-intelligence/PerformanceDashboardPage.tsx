"use client";

import { useEffect } from "react";
import { useMarketingIntelligenceStore } from "@/stores/marketing-intelligence.store";
import FilterBar from "../shared/FilterBar";
import MetricCard from "../shared/MetricCard";
import DataTable, { DataTableColumn } from "../shared/DataTable";
import ProviderBadge, { BadgeProvider } from "../shared/ProviderBadge";
import EmptyState from "../shared/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import type { MICampaignRow, MIPlatformFilter } from "@/types/marketing-intelligence.types";

const PLATFORM_OPTIONS: { label: string; value: MIPlatformFilter }[] = [
  { label: "All platforms", value: "all" },
  { label: "Meta", value: "META" },
  { label: "TikTok", value: "TIKTOK" },
  { label: "X", value: "X" },
  { label: "LinkedIn", value: "LINKEDIN" },
  { label: "Google Ads", value: "GOOGLE_ADS" },
];

function formatCurrency(value: number | null, currency: string | null) {
  if (value === null || !currency) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

interface PerformanceDashboardPageProps {
  onNavigateToConnections?: () => void;
}

export default function PerformanceDashboardPage({ onNavigateToConnections }: PerformanceDashboardPageProps) {
  const {
    dashboardFilters, setDashboardFilters, performance, isLoadingPerformance, fetchPerformance,
    error, clearError,
  } = useMarketingIntelligenceStore();

  useEffect(() => {
    fetchPerformance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) {
      const t = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(t);
    }
  }, [error, clearError]);

  const summary = performance?.summary;
  const campaigns = performance?.campaigns ?? [];
  const activeFilterCount =
    (dashboardFilters.platform !== "all" ? 1 : 0) +
    (dashboardFilters.search ? 1 : 0) +
    (dashboardFilters.currency !== "all" ? 1 : 0);

  const currencyOptions = performance?.summaryByCurrency
    ? [{ label: "All currencies", value: "all" }, ...Object.keys(performance.summaryByCurrency).map((c) => ({ label: c, value: c }))]
    : [{ label: summary?.currency ?? "—", value: "all" }];

  // Client-side pin into one currency's totals when the range is mixed — never sums across currencies.
  const pinnedCurrency = dashboardFilters.currency !== "all" ? dashboardFilters.currency : null;
  const pinnedTotals = pinnedCurrency ? performance?.summaryByCurrency?.[pinnedCurrency] : null;

  const columns: DataTableColumn<MICampaignRow>[] = [
    { key: "platform", header: "Platform", render: (r) => <ProviderBadge provider={r.platform as BadgeProvider} size="sm" /> },
    { key: "campaignName", header: "Campaign", render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium">{r.campaignName}</span>
          <span className="text-[10px] text-muted-foreground">{r.campaignExternalId}</span>
        </div>
      ) },
    { key: "currency", header: "Currency", render: (r) => r.currency },
    { key: "spend", header: "Spend", render: (r) => formatCurrency(r.spend, r.currency) },
    { key: "impressions", header: "Impressions", render: (r) => r.impressions.toLocaleString() },
    { key: "clicks", header: "Clicks", render: (r) => r.clicks.toLocaleString() },
    { key: "signups", header: "Signups", render: (r) => r.signups.toLocaleString() },
    { key: "payments", header: "Payments", render: (r) => r.payments.toLocaleString() },
    { key: "revenue", header: "Revenue", render: (r) => formatCurrency(r.revenue, r.currency) },
    { key: "cpa", header: "CPA", render: (r) => (r.cpa === null ? "—" : formatCurrency(r.cpa, r.currency)) },
    { key: "conversionRate", header: "Conv. Rate", render: (r) => (r.conversionRate === null ? "—" : `${r.conversionRate}%`) },
  ];

  const filteredCampaigns = campaigns
    .filter((c) => !dashboardFilters.search || c.campaignName.toLowerCase().includes(dashboardFilters.search.toLowerCase()))
    .filter((c) => dashboardFilters.currency === "all" || c.currency === dashboardFilters.currency);

  if (isLoadingPerformance && !performance) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-full max-w-lg" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[100px] rounded-xl" />)}
        </div>
        <Skeleton className="h-[300px] rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">
          {error}
        </div>
      )}

      <FilterBar
        dateRange={{
          from: dashboardFilters.from,
          to: dashboardFilters.to,
          onChange: (from, to) => setDashboardFilters({ from, to }),
        }}
        selects={[
          {
            key: "platform", label: "Platform", value: dashboardFilters.platform,
            options: PLATFORM_OPTIONS.map((p) => ({ label: p.label, value: p.value })),
            onChange: (v) => setDashboardFilters({ platform: v as MIPlatformFilter }),
          },
          {
            key: "currency", label: "Currency", value: dashboardFilters.currency,
            options: currencyOptions,
            onChange: (v) => setDashboardFilters({ currency: v }),
          },
        ]}
        search={{
          value: dashboardFilters.search, placeholder: "Search campaign",
          onChange: (v) => setDashboardFilters({ search: v }),
        }}
        activeFilterCount={activeFilterCount}
        onReset={() => setDashboardFilters({ platform: "all", search: "", currency: "all" })}
      />

      {performance && (
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="font-poppins text-[11px] text-muted-foreground">
            Data as of {new Date(performance.asOf).toLocaleString()}
          </span>
          {onNavigateToConnections && (
            <button
              onClick={onNavigateToConnections}
              className="font-poppins text-[11px] font-medium text-primary underline"
            >
              View connection health
            </button>
          )}
        </div>
      )}

      {performance?.partial && performance.platformErrors.length > 0 && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3">
          <p className="font-poppins text-[12px] font-medium text-foreground">
            Some providers didn&apos;t return data — figures below reflect what&apos;s available.
          </p>
          <div className="flex flex-col gap-1 mt-1.5">
            {performance.platformErrors.map((pe) => (
              <span key={pe.platform} className="font-poppins text-[11px] text-muted-foreground">
                {pe.platform}: {pe.code.replace(/_/g, " ").toLowerCase()}
              </span>
            ))}
          </div>
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricCard
            label="Spend"
            value={pinnedTotals ? pinnedTotals.spend : summary.mixedCurrencies ? null : summary.spend}
            unavailableReason="Multiple currencies"
          />
          <MetricCard label="Impressions" value={summary.impressions} />
          <MetricCard label="Clicks" value={summary.clicks} />
          <MetricCard
            label="Revenue"
            value={pinnedTotals ? pinnedTotals.revenue : summary.mixedCurrencies ? null : summary.revenue}
            unavailableReason="Multiple currencies"
          />
          <MetricCard label="Signups" value={summary.signups} />
          <MetricCard label="Payments" value={summary.payments} />
          <MetricCard
            label="CPA"
            value={pinnedTotals ? pinnedTotals.cpa : summary.currencyCompatibility ? summary.cpa : null}
            unavailableReason="Currency incompatible"
          />
          <MetricCard
            label="Conversion Rate"
            value={summary.currencyCompatibility && summary.conversionRate !== null ? `${summary.conversionRate}%` : null}
            unavailableReason="Currency incompatible"
          />
        </div>
      )}

      {summary?.mixedCurrencies && performance?.summaryByCurrency && (
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="font-poppins text-[12px] font-medium text-foreground mb-3">Totals by currency</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(performance.summaryByCurrency).map(([currency, totals]) => (
              <div key={currency} className="border border-border rounded-lg p-3">
                <p className="font-poppins text-[11px] font-semibold text-muted-foreground mb-1">{currency}</p>
                <p className="font-poppins text-[13px] text-foreground">Spend: {formatCurrency(totals.spend, currency)}</p>
                <p className="font-poppins text-[13px] text-foreground">Revenue: {formatCurrency(totals.revenue, currency)}</p>
                <p className="font-poppins text-[13px] text-foreground">
                  CPA: {totals.cpa === null ? "—" : formatCurrency(totals.cpa, currency)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Campaigns</p>
        {filteredCampaigns.length === 0 ? (
          <EmptyState message="No campaigns in this range" description="Try widening the date range or clearing filters." />
        ) : (
          <DataTable columns={columns} rows={filteredCampaigns} rowKey={(r) => `${r.platform}-${r.campaignExternalId}`} />
        )}
      </div>
    </div>
  );
}