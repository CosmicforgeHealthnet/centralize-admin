"use client";

import { useEffect, useState } from "react";
import { useITStore } from "@/stores/it.store";
import {
  SkeletonRow,
  StatusBadge,
  TableSearch,
  TablePagination,
  ErrorBanner,
  formatDate,
  truncateId,
} from "./table.utils";

const NEXT_STATUS: Record<string, string[]> = {
  pending:   ["scheduled", "cancelled"],
  scheduled: ["completed", "cancelled"],
};

export default function ConsultationTable() {
  const consultations       = useITStore((s) => s.consultations);
  const pagination          = useITStore((s) => s.consultationPagination);
  const filters             = useITStore((s) => s.consultationFilters);
  const isLoading           = useITStore((s) => s.isLoadingConsultations);
  const error               = useITStore((s) => s.error);
  const setFilters          = useITStore((s) => s.setConsultationFilters);
  const fetch               = useITStore((s) => s.fetchConsultations);
  const transition          = useITStore((s) => s.transitionConsultation);
  const clearError          = useITStore((s) => s.clearError);

  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [transitioning, setTransitioning] = useState<string | null>(null);

  useEffect(() => { fetch(); }, [filters.page, filters.status]);

  const handleSearch = () => {
    setFilters({ search: searchDraft, page: 1 });
    fetch();
  };

  const handleTransition = async (id: string, status: string) => {
    setTransitioning(id);
    await transition(id, status);
    setTransitioning(null);
  };

  const currentPage = pagination?.currentPage ?? 1;
  const totalPages  = pagination?.totalPages ?? 1;
  const totalItems  = pagination?.totalItems ?? 0;

  const HEADERS = ["ID", "Patient", "Doctor", "Status", "Date", "Payment", "Action"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <h2 className="text-[15px] font-poppins font-semibold text-foreground">
          Consultations
          {pagination && (
            <span className="ml-2 text-[12px] font-normal text-muted-foreground">({totalItems} total)</span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <select
            value={filters.status}
            onChange={(e) => { setFilters({ status: e.target.value, page: 1 }); fetch(); }}
            className="h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
          >
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="scheduled">Scheduled</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <TableSearch value={searchDraft} onChange={setSearchDraft} onSearch={handleSearch} />
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
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
            ) : consultations.length === 0 ? (
              <tr>
                <td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  No consultations found
                </td>
              </tr>
            ) : (
              consultations.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground font-mono">
                    {truncateId(row.id)}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground">
                    {truncateId(row.patientId)}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground">
                    {truncateId(row.doctorId)}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground whitespace-nowrap">
                    {formatDate(row.appointmentDate)}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <StatusBadge status={row.paymentStatus} />
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    {NEXT_STATUS[row.status] ? (
                      <select
                        disabled={transitioning === row.id}
                        defaultValue=""
                        onChange={(e) => e.target.value && handleTransition(row.id, e.target.value)}
                        className="h-[30px] px-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg outline-none cursor-pointer disabled:opacity-60"
                      >
                        <option value="" disabled>Move to</option>
                        {NEXT_STATUS[row.status].map((s) => (
                          <option key={s} value={s} className="bg-white text-foreground capitalize">
                            {s}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[12px] font-poppins text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))
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