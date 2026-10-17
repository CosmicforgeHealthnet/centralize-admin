"use client";

import { useEffect } from "react";
import { Bell, Search, AlertCircle } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import DataTable, { type DataTableColumn } from "@/components/marketing/shared/DataTable";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import StatusChip from "@/components/marketing/shared/StatusChip";
import type {
  AMIAlertListItem,
  AMIAlertSeverity,
  AMIAlertStatus,
  AMIAlertType,
  MIPlatform,
} from "@/types/ai-marketing-intelligence.types";

const SEVERITY_OPTIONS: { value: AMIAlertSeverity | "all"; label: string }[] = [
  { value: "all", label: "All severities" },
  { value: "CRITICAL", label: "Critical" },
  { value: "WARNING", label: "Warning" },
  { value: "INFO", label: "Info" },
];

const STATUS_OPTIONS: { value: AMIAlertStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "OPEN", label: "Open" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "RESOLVED", label: "Resolved" },
];

const TYPE_OPTIONS: { value: AMIAlertType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "CPA_TARGET_BREACH", label: "CPA target breach" },
  { value: "SPEND_WITHOUT_CONVERSION", label: "Spend without conversion" },
  { value: "CONVERSION_RATE_DROP", label: "Conversion rate drop" },
  { value: "CREATIVE_FATIGUE", label: "Creative fatigue" },
  { value: "SYNC_STALE", label: "Sync stale" },
  { value: "CAMPAIGN_PERFORMANCE_DROP", label: "Campaign performance drop" },
  { value: "HIGH_PERFORMING_CAMPAIGN", label: "High performing campaign" },
  { value: "TOKEN_REFRESH_FAILED", label: "Token refresh failed" },
  { value: "CONNECTION_DEGRADED", label: "Connection degraded" },
  { value: "PLATFORM_PERMISSION_ERROR", label: "Platform permission error" },
];

const PLATFORM_OPTIONS: { value: MIPlatform | "all"; label: string }[] = [
  { value: "all", label: "All platforms" },
  { value: "META", label: "Meta" },
  { value: "TIKTOK", label: "TikTok" },
  { value: "X", label: "X" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "GOOGLE_ADS", label: "Google Ads" },
];

function selectClass() {
  return "font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 w-full sm:w-auto";
}

function severityTone(severity: AMIAlertSeverity): "danger" | "warning" | "info" {
  if (severity === "CRITICAL") return "danger";
  if (severity === "WARNING") return "warning";
  return "info";
}

interface AlertsPageProps {
  onOpenAlert: (id: string) => void;
}

export default function AlertsPage({ onOpenAlert }: AlertsPageProps) {
  const { alerts, alertFilters, isLoadingAlerts, error, fetchAlerts, setAlertFilters } = useAIMarketingIntelligenceStore();

  useEffect(() => {
    fetchAlerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: DataTableColumn<AMIAlertListItem>[] = [
    {
      key: "severity",
      header: "Severity",
      render: (row) => <StatusChip status={row.severity} tone={severityTone(row.severity)} />,
      width: "90px",
    },
    {
      key: "type",
      header: "Alert",
      render: (row) => (
        <div className="min-w-0">
          <p className="font-poppins text-[12px] font-medium text-foreground truncate max-w-[220px]" title={row.type.replace(/_/g, " ")}>
            {row.type.replace(/_/g, " ")}
          </p>
          <p className="font-poppins text-[10px] text-muted-foreground truncate max-w-[220px]" title={row.message}>
            {row.message}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <StatusChip status={row.status} />,
    },
    {
      key: "platform",
      header: "Platform",
      render: (row) => (row.platform ? <ProviderBadge provider={row.platform as BadgeProvider} size="sm" /> : <span className="font-poppins text-[11px] text-muted-foreground">—</span>),
    },
    {
      key: "occurrence",
      header: "Occurrences",
      render: (row) => <span className="font-poppins text-[12px] text-foreground">{row.occurrenceCount}</span>,
      width: "90px",
    },
    {
      key: "lastTriggered",
      header: "Last triggered",
      render: (row) => (
        <span className="font-poppins text-[11px] text-muted-foreground whitespace-nowrap">
          {new Date(row.lastTriggeredAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <button onClick={() => onOpenAlert(row.id)} className="font-poppins text-[11px] font-medium text-primary hover:opacity-80 whitespace-nowrap">
          View
        </button>
      ),
      width: "60px",
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Bell className="w-4 h-4 text-primary" strokeWidth={2} />
        <div>
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">Alerts Centre</h2>
          <p className="font-poppins text-[11px] text-muted-foreground">Operational and performance conditions.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border pb-2 overflow-x-auto">
        {(["all", "operational", "performance"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setAlertFilters({ tab })}
            className={`font-poppins text-[12px] font-medium px-3 py-1.5 rounded-full whitespace-nowrap transition-colors ${
              alertFilters.tab === tab ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "all" ? "All" : tab === "operational" ? "Operational health" : "Performance"}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
        <div className="relative w-full sm:w-56">
          <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" strokeWidth={2} />
          <input
            value={alertFilters.campaignExternalId}
            onChange={(e) => setAlertFilters({ campaignExternalId: e.target.value })}
            placeholder="Search campaign…"
            className="font-poppins text-[12px] bg-card border border-border rounded-[8px] pl-8 pr-3 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 w-full"
          />
        </div>
        <select value={alertFilters.severity} onChange={(e) => setAlertFilters({ severity: e.target.value as AMIAlertSeverity | "all" })} className={selectClass()}>
          {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={alertFilters.status} onChange={(e) => setAlertFilters({ status: e.target.value as AMIAlertStatus | "all" })} className={selectClass()}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={alertFilters.type} onChange={(e) => setAlertFilters({ type: e.target.value as AMIAlertType | "all" })} className={selectClass()}>
          {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={alertFilters.platform} onChange={(e) => setAlertFilters({ platform: e.target.value as MIPlatform | "all" })} className={selectClass()}>
          {PLATFORM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={alerts}
        rowKey={(row) => row.id}
        isLoading={isLoadingAlerts}
        emptyLabel="No alerts match the current filters"
      />
    </div>
  );
}