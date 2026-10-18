"use client";

import { useEffect } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, TablePagination, ErrorBanner, formatDate } from "./table.utils";
import { RefreshCw, Activity } from "lucide-react";

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  healthy:   { bg: "bg-green-500/10",      text: "text-green-600",       dot: "#0DA53F" },
  degraded:  { bg: "bg-yellow-500/10",     text: "text-yellow-600",      dot: "#E8B600" },
  unhealthy: { bg: "bg-destructive/10",    text: "text-destructive",     dot: "#F64545" },
  unknown:   { bg: "bg-muted",             text: "text-muted-foreground", dot: "#8F90A4" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status.toLowerCase()] ?? STATUS_STYLES.unknown;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-semibold ${s.bg} ${s.text}`}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function ResponseBar({ ms }: { ms: number | null }) {
  if (ms == null) return <span className="text-[12px] font-poppins text-muted-foreground">—</span>;
  const color = ms < 200 ? "#0DA53F" : ms < 500 ? "#E8B600" : "#F64545";
  const width = Math.min((ms / 2000) * 100, 100);
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${width}%`, backgroundColor: color }} />
      </div>
      <span className="text-[12px] font-poppins text-muted-foreground">{ms}ms</span>
    </div>
  );
}

function UptimeBadge({ uptime }: { uptime: number | null }) {
  if (uptime == null) return <span className="text-[12px] font-poppins text-muted-foreground">—</span>;
  const hours = Math.floor(uptime / 3600);
  const mins  = Math.floor((uptime % 3600) / 60);
  return (
    <span className="text-[12px] font-poppins text-foreground font-mono">
      {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}
    </span>
  );
}

export default function HealthHistoryTable() {
  const history       = useAdminOpsStore((s) => s.healthHistory);
  const pagination    = useAdminOpsStore((s) => s.healthPagination);
  const filters       = useAdminOpsStore((s) => s.healthFilters);
  const latestHealth  = useAdminOpsStore((s) => s.latestHealth);
  const isLoading     = useAdminOpsStore((s) => s.isLoadingHealth);
  const error         = useAdminOpsStore((s) => s.error);
  const fetch         = useAdminOpsStore((s) => s.fetchHealthHistory);
  const fetchLatest   = useAdminOpsStore((s) => s.fetchLatestHealth);
  const setFilters    = useAdminOpsStore((s) => s.setHealthFilters);
  const clearError    = useAdminOpsStore((s) => s.clearError);

  useEffect(() => {
    fetch();
    fetchLatest();
  }, [filters.page]);

  const HEADERS = ["Checked At", "Status", "Environment", "Version", "Response Time", "Uptime", "Details"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col gap-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">
            Health History
            {pagination && (
              <span className="ml-2 text-[12px] font-normal text-muted-foreground">({pagination.totalItems} records)</span>
            )}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">System health check snapshots over time</p>
        </div>
        <button
          onClick={() => { fetch(); fetchLatest(); }}
          className="h-[36px] px-4 bg-muted border border-border text-[12px] font-poppins text-foreground rounded-lg flex items-center gap-1.5 hover:bg-muted/80 transition-colors self-start sm:self-auto"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      {/* Latest Health Banner */}
      {latestHealth && (
        <div className={`mx-4 mb-4 px-4 py-3 rounded-xl border flex flex-col sm:flex-row sm:items-center gap-3 ${
          STATUS_STYLES[latestHealth.status.toLowerCase()]?.bg ?? "bg-muted"
        } border-border`}>
          <Activity className={`w-4 h-4 shrink-0 ${STATUS_STYLES[latestHealth.status.toLowerCase()]?.text ?? "text-muted-foreground"}`} />
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 flex-1">
            <span className="text-[13px] font-poppins font-semibold text-foreground">Current Status</span>
            <StatusBadge status={latestHealth.status} />
            {latestHealth.environment && (
              <span className="text-[12px] font-poppins text-muted-foreground">env: <span className="text-foreground font-medium">{latestHealth.environment}</span></span>
            )}
            {latestHealth.version && (
              <span className="text-[12px] font-poppins text-muted-foreground">v{latestHealth.version}</span>
            )}
            {latestHealth.responseTimeMs != null && (
              <span className="text-[12px] font-poppins text-muted-foreground">{latestHealth.responseTimeMs}ms</span>
            )}
          </div>
          <span className="text-[11px] font-poppins text-muted-foreground shrink-0">
            Checked {formatDate(latestHealth.checkedAt)}
          </span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px]">
          <thead>
            <tr className="border-b border-border">
              {HEADERS.map((h) => (
                <th key={h} className="text-left py-2.5 px-4 sm:px-5 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={HEADERS.length} />)
            ) : history.length === 0 ? (
              <tr>
                <td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  No health records found
                </td>
              </tr>
            ) : (
              history.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">
                    {formatDate(row.checkedAt)}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground capitalize">
                    {row.environment ?? "—"}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins font-mono text-muted-foreground">
                    {row.version ? `v${row.version}` : "—"}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <ResponseBar ms={row.responseTimeMs} />
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <UptimeBadge uptime={row.uptime} />
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">
                    {row.details && Object.keys(row.details).length > 0 ? (
                      <details className="cursor-pointer">
                        <summary className="text-primary text-[11px] font-poppins font-semibold hover:underline select-none">
                          View ({Object.keys(row.details).length} keys)
                        </summary>
                        <pre className="mt-1 text-[10px] font-mono bg-muted rounded p-2 max-w-[240px] overflow-auto max-h-[100px]">
                          {JSON.stringify(row.details, null, 2)}
                        </pre>
                      </details>
                    ) : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <TablePagination
        currentPage={pagination?.currentPage ?? 1}
        totalPages={pagination?.totalPages ?? 1}
        onPageChange={(p) => { setFilters({ page: p }); fetch(); }}
      />
    </div>
  );
}