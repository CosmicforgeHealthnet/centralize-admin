"use client";

import { useEffect } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, StatusBadge, TablePagination, ErrorBanner, formatDate, truncateId } from "./table.utils";

const HEADERS = ["ID", "Job Name", "Type", "Status", "Started", "Completed", "Duration", "Attempts", "Error"];

export default function JobMonitoringTable() {
  const jobs       = useAdminOpsStore((s) => s.jobs);
  const pagination = useAdminOpsStore((s) => s.jobPagination);
  const filters    = useAdminOpsStore((s) => s.jobFilters);
  const isLoading  = useAdminOpsStore((s) => s.isLoadingJobs);
  const error      = useAdminOpsStore((s) => s.error);
  const fetch      = useAdminOpsStore((s) => s.fetchJobs);
  const setFilters = useAdminOpsStore((s) => s.setJobFilters);
  const clearError = useAdminOpsStore((s) => s.clearError);

  useEffect(() => { fetch(); }, [filters.page, filters.status]);

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">
            Job Monitor
            {pagination && <span className="ml-2 text-[12px] font-normal text-muted-foreground">({pagination.totalItems} executions)</span>}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">Cron and background job execution history</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filters.status}
            onChange={(e) => { setFilters({ status: e.target.value, page: 1 }); fetch(); }}
            className="h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
          >
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="dead_letter">Dead Letter</option>
          </select>
          <select
            value={filters.search}
            onChange={(e) => { setFilters({ search: e.target.value, page: 1 }); fetch(); }}
            className="h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
          >
            <option value="">All Types</option>
            <option value="cron">Cron</option>
            <option value="background">Background</option>
            <option value="scheduled">Scheduled</option>
            <option value="manual">Manual</option>
          </select>
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead>
            <tr className="border-b border-border">
              {HEADERS.map((h) => (
                <th key={h} className="text-left py-2.5 px-4 sm:px-5 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={HEADERS.length} />)
            ) : jobs.length === 0 ? (
              <tr><td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">No job executions found</td></tr>
            ) : (
              jobs.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground font-mono">{truncateId(row.id)}</td>
                  <td className="py-3 px-4 sm:px-5">
                    <span className="text-[13px] font-poppins font-medium text-foreground">{row.jobName}</span>
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <span className="px-2 py-0.5 bg-muted rounded-md text-[11px] font-poppins text-muted-foreground capitalize">{row.jobType}</span>
                  </td>
                  <td className="py-3 px-4 sm:px-5"><StatusBadge status={row.status} /></td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{row.startedAt ? formatDate(row.startedAt) : "—"}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{row.completedAt ? formatDate(row.completedAt) : "—"}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">
                    {row.durationMs != null ? (
                      <span className={row.durationMs > 5000 ? "text-amber-500 font-semibold" : ""}>{row.durationMs}ms</span>
                    ) : "—"}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground text-center">{row.attempts}</td>
                  <td className="py-3 px-4 sm:px-5 max-w-[200px]">
                    {row.error ? (
                      <span className="text-[11px] font-poppins text-destructive truncate block" title={row.error}>{row.error}</span>
                    ) : <span className="text-[12px] font-poppins text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <TablePagination currentPage={pagination?.currentPage ?? 1} totalPages={pagination?.totalPages ?? 1} onPageChange={(p) => { setFilters({ page: p }); fetch(); }} />
    </div>
  );
}