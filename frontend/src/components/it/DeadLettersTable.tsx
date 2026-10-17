"use client";

import { useEffect } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, TablePagination, ErrorBanner, formatDate } from "./table.utils";
import { CheckCircle } from "lucide-react";

const STATUS_COLOR: Record<string, string> = {
  pending_retry: "#E8B600", exhausted: "#F64545", manually_resolved: "#0DA53F",
};

export default function DeadLettersTable() {
  const deadLetters  = useAdminOpsStore((s) => s.deadLetters);
  const pagination   = useAdminOpsStore((s) => s.deadLetterPagination);
  const filters      = useAdminOpsStore((s) => s.deadLetterFilters);
  const isLoading    = useAdminOpsStore((s) => s.isLoadingDeadLetters);
  const actionLoad   = useAdminOpsStore((s) => s.actionLoading);
  const error        = useAdminOpsStore((s) => s.error);
  const fetch        = useAdminOpsStore((s) => s.fetchDeadLetters);
  const setFilters   = useAdminOpsStore((s) => s.setDeadLetterFilters);
  const resolve      = useAdminOpsStore((s) => s.resolveDeadLetter);
  const clearError   = useAdminOpsStore((s) => s.clearError);

  useEffect(() => { fetch(); }, [filters.page, filters.status]);

  const HEADERS = ["Job Name", "Status", "Failed At", "Retries", "Max Retries", "Error", "Resolved By", "Actions"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">
            Dead Letters
            {pagination && <span className="ml-2 text-[12px] font-normal text-muted-foreground">({pagination.totalItems} items)</span>}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">Jobs that exhausted all retry attempts</p>
        </div>
        <select
          value={filters.status}
          onChange={(e) => { setFilters({ status: e.target.value, page: 1 }); fetch(); }}
          className="h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
        >
          <option value="">All Status</option>
          <option value="pending_retry">Pending Retry</option>
          <option value="exhausted">Exhausted</option>
          <option value="manually_resolved">Resolved</option>
        </select>
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
              Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={HEADERS.length} />)
            ) : deadLetters.length === 0 ? (
              <tr><td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">No dead letter jobs</td></tr>
            ) : (
              deadLetters.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins font-semibold text-foreground">{row.jobName}</td>
                  <td className="py-3 px-4 sm:px-5">
                    <span className="text-[12px] font-poppins font-semibold capitalize" style={{ color: STATUS_COLOR[row.status] ?? "#8F90A4" }}>
                      {row.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{formatDate(row.failedAt)}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">{row.retryCount}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">{row.maxRetries}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-destructive max-w-[180px] truncate">{row.errorMessage ?? "—"}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">{row.resolvedBy ?? "—"}</td>
                  <td className="py-3 px-4 sm:px-5">
                    {row.status !== "manually_resolved" && (
                      <button
                        onClick={() => resolve(row.id)}
                        disabled={actionLoad === row.id}
                        className="h-[28px] px-2.5 bg-primary/10 text-primary text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/20 transition-colors disabled:opacity-60 flex items-center gap-1"
                      >
                        <CheckCircle className="w-3 h-3" /> Resolve
                      </button>
                    )}
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