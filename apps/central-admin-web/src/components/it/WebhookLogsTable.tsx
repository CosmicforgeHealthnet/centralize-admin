"use client";

import { useEffect } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, TablePagination, ErrorBanner, formatDate } from "./table.utils";

const STATUS_COLOR: Record<string, string> = {
  success: "#0DA53F", failed: "#F64545", pending: "#E8B600",
};

export default function WebhookLogsTable() {
  const logs        = useAdminOpsStore((s) => s.webhookLogs);
  const pagination  = useAdminOpsStore((s) => s.webhookLogPagination);
  const filters     = useAdminOpsStore((s) => s.webhookLogFilters);
  const isLoading   = useAdminOpsStore((s) => s.isLoadingWebhookLogs);
  const error       = useAdminOpsStore((s) => s.error);
  const fetch       = useAdminOpsStore((s) => s.fetchWebhookLogs);
  const setFilters  = useAdminOpsStore((s) => s.setWebhookLogFilters);
  const clearError  = useAdminOpsStore((s) => s.clearError);

  useEffect(() => { fetch(); }, [filters.page, filters.status]);

  const HEADERS = ["Event", "Status", "Status Code", "Attempt", "Provider", "Delivered At", "Error"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">
            Webhook Logs
            {pagination && <span className="ml-2 text-[12px] font-normal text-muted-foreground">({pagination.totalItems} entries)</span>}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">Delivery history for all webhook events</p>
        </div>
        <select
          value={filters.status}
          onChange={(e) => { setFilters({ status: e.target.value, page: 1 }); fetch(); }}
          className="h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
        >
          <option value="">All Status</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
        </select>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px]">
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
            ) : logs.length === 0 ? (
              <tr><td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">No webhook logs</td></tr>
            ) : (
              logs.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins font-semibold text-foreground">{row.event}</td>
                  <td className="py-3 px-4 sm:px-5">
                    <span className="text-[12px] font-poppins font-semibold capitalize" style={{ color: STATUS_COLOR[row.status] ?? "#8F90A4" }}>
                      {row.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    {row.statusCode != null && (
                      <span className={`text-[12px] font-poppins font-mono font-semibold ${row.statusCode >= 200 && row.statusCode < 300 ? "text-green-500" : "text-destructive"}`}>
                        {row.statusCode}
                      </span>
                    )}
                    {row.statusCode == null && <span className="text-[12px] font-poppins text-muted-foreground">—</span>}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">{row.attempt}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground capitalize">{row.provider ?? "—"}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">
                    {row.deliveredAt ? formatDate(row.deliveredAt) : "—"}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-destructive max-w-[200px] truncate">{row.error ?? "—"}</td>
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