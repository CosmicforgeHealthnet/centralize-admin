"use client";

import { useEffect, useState } from "react";
import { useITStore } from "@/stores/it.store";
import {
  SkeletonRow,
  TableSearch,
  TablePagination,
  ErrorBanner,
  formatDate,
  truncateId,
} from "./table.utils";

const ACTION_STYLE: Record<string, { bg: string; text: string }> = {
  CONSULTATION_CREATED:   { bg: "rgba(39,46,167,0.10)",  text: "#272EA7" },
  CONSULTATION_COMPLETED: { bg: "rgba(13,165,63,0.12)",  text: "#0DA53F" },
  CONSULTATION_CANCELLED: { bg: "rgba(246,69,69,0.12)",  text: "#F64545" },
  RTC_SESSION_STARTED:    { bg: "rgba(13,165,63,0.12)",  text: "#0DA53F" },
  RTC_SESSION_ENDED:      { bg: "rgba(143,144,164,0.15)", text: "#8F90A4" },
  RTC_SESSION_FAILED:     { bg: "rgba(246,69,69,0.12)",  text: "#F64545" },
  PAYMENT_SUCCESS:        { bg: "rgba(13,165,63,0.12)",  text: "#0DA53F" },
  PAYMENT_FAILED:         { bg: "rgba(246,69,69,0.12)",  text: "#F64545" },
  DELIVERY_COMPLETED:     { bg: "rgba(13,165,63,0.12)",  text: "#0DA53F" },
  DELIVERY_FAILED:        { bg: "rgba(246,69,69,0.12)",  text: "#F64545" },
};

export default function AuditLogTable() {
  const auditLogs  = useITStore((s) => s.auditLogs);
  const pagination = useITStore((s) => s.auditPagination);
  const filters    = useITStore((s) => s.auditFilters);
  const isLoading  = useITStore((s) => s.isLoadingAudit);
  const error      = useITStore((s) => s.error);
  const setFilters = useITStore((s) => s.setAuditFilters);
  const fetch      = useITStore((s) => s.fetchAuditLogs);
  const clearError = useITStore((s) => s.clearError);

  const [searchDraft, setSearchDraft] = useState(filters.search);

  useEffect(() => { fetch(); }, [filters.page]);

  const handleSearch = () => {
    setFilters({ search: searchDraft, page: 1 });
    fetch();
  };

  const currentPage = pagination?.currentPage ?? 1;
  const totalPages  = pagination?.totalPages ?? 1;
  const totalItems  = pagination?.totalItems ?? 0;

  const HEADERS = ["Resource", "Resource ID", "Action", "Actor", "Role", "Timestamp"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <h2 className="text-[15px] font-poppins font-semibold text-foreground">
          Audit Logs
          {pagination && (
            <span className="ml-2 text-[12px] font-normal text-muted-foreground">({totalItems} total)</span>
          )}
        </h2>
        <TableSearch value={searchDraft} onChange={setSearchDraft} onSearch={handleSearch} />
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px]">
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
              Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={HEADERS.length} />)
            ) : auditLogs.length === 0 ? (
              <tr>
                <td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  No audit logs found
                </td>
              </tr>
            ) : (
              auditLogs.map((row) => {
                const style = ACTION_STYLE[row.action] ?? { bg: "rgba(143,144,164,0.15)", text: "#8F90A4" };
                return (
                  <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground capitalize">
                      {row.resourceType.replace(/_/g, " ")}
                    </td>
                    <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground font-mono">
                      {truncateId(row.resourceId)}
                    </td>
                    <td className="py-3 px-4 sm:px-5">
                      <span
                        className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap"
                        style={{ backgroundColor: style.bg, color: style.text }}
                      >
                        {row.action.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground">
                      {row.actorUserId ? truncateId(row.actorUserId) : "system"}
                    </td>
                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground capitalize">
                      {row.actorRole ?? "system"}
                    </td>
                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground whitespace-nowrap">
                      {formatDate(row.createdAt)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <TablePagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={(p) => { setFilters({ page: p }); fetch(); }}
      />
    </div>
  );
}