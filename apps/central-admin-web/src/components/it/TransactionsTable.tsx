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
  pending:    ["completed", "failed"],
  processing: ["completed", "failed"],
  completed:  ["refunded"],
};

export default function TransactionsTable() {
  const transactions  = useITStore((s) => s.transactions);
  const pagination    = useITStore((s) => s.transactionPagination);
  const filters       = useITStore((s) => s.transactionFilters);
  const isLoading     = useITStore((s) => s.isLoadingTransactions);
  const error         = useITStore((s) => s.error);
  const setFilters    = useITStore((s) => s.setTransactionFilters);
  const fetch         = useITStore((s) => s.fetchTransactions);
  const transition    = useITStore((s) => s.transitionPayment);
  const flag          = useITStore((s) => s.flagTransaction);
  const clearError    = useITStore((s) => s.clearError);

  const [searchDraft, setSearchDraft]   = useState(filters.search);
  const [actionId, setActionId]         = useState<string | null>(null);
  const [flaggingId, setFlaggingId]     = useState<string | null>(null);
  const [flagReason, setFlagReason]     = useState("");

  useEffect(() => { fetch(); }, [filters.page, filters.status]);

  const handleSearch = () => {
    setFilters({ search: searchDraft, page: 1 });
    fetch();
  };

  const handleTransition = async (id: string, status: string) => {
    setActionId(id);
    await transition(id, status);
    setActionId(null);
  };

  const handleFlag = async (id: string) => {
    if (!flagReason.trim()) return;
    setActionId(id);
    await flag(id, flagReason);
    setFlaggingId(null);
    setFlagReason("");
    setActionId(null);
  };

  const currentPage = pagination?.currentPage ?? 1;
  const totalPages  = pagination?.totalPages ?? 1;
  const totalItems  = pagination?.totalItems ?? 0;

  const HEADERS = ["ID", "Patient", "Service", "Amount", "Currency", "Status", "Funds", "Created", "Action"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <h2 className="text-[15px] font-poppins font-semibold text-foreground">
          Transactions
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
            <option value="processing">Processing</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="disputed">Disputed</option>
            <option value="refunded">Refunded</option>
          </select>
          <TableSearch value={searchDraft} onChange={setSearchDraft} onSearch={handleSearch} />
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      {flaggingId && (
        <div className="mx-4 mb-3 px-4 py-3 rounded-lg bg-muted border border-border flex items-center gap-3">
          <input
            type="text"
            placeholder="Reason for flagging..."
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
            className="flex-1 bg-transparent text-[13px] font-poppins text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={() => handleFlag(flaggingId)}
            disabled={!flagReason.trim() || actionId === flaggingId}
            className="h-[30px] px-4 bg-destructive text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-destructive/90 transition-colors disabled:opacity-60"
          >
            Confirm
          </button>
          <button
            onClick={() => { setFlaggingId(null); setFlagReason(""); }}
            className="h-[30px] px-3 bg-muted border border-border text-[12px] font-poppins text-foreground rounded-lg hover:bg-muted/80 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px]">
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
            ) : transactions.length === 0 ? (
              <tr>
                <td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  No transactions found
                </td>
              </tr>
            ) : (
              transactions.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground font-mono">
                    {truncateId(row.id)}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground">
                    {truncateId(row.patientId)}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground capitalize">
                    {row.serviceType}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins font-semibold text-foreground">
                    {Number(row.originalAmount).toLocaleString()}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-muted-foreground">
                    {row.originalCurrency}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground capitalize">
                    {row.fundsStatus.replace(/_/g, " ")}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground whitespace-nowrap">
                    {formatDate(row.createdAt)}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <div className="flex items-center gap-2">
                      {NEXT_STATUS[row.status] && (
                        <select
                          disabled={actionId === row.id}
                          defaultValue=""
                          onChange={(e) => e.target.value && handleTransition(row.id, e.target.value)}
                          className="h-[30px] px-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg outline-none cursor-pointer disabled:opacity-60"
                        >
                          <option value="" disabled>Move to</option>
                          {NEXT_STATUS[row.status].map((s) => (
                            <option key={s} value={s} className="bg-white text-foreground capitalize">{s}</option>
                          ))}
                        </select>
                      )}
                      {row.status !== "disputed" && row.status !== "cancelled" && row.status !== "failed" && (
                        <button
                          onClick={() => setFlaggingId(row.id)}
                          disabled={actionId === row.id}
                          className="h-[30px] px-3 bg-destructive/10 text-destructive text-[12px] font-poppins font-semibold rounded-lg hover:bg-destructive/20 transition-colors disabled:opacity-60 whitespace-nowrap"
                        >
                          Flag
                        </button>
                      )}
                      {!NEXT_STATUS[row.status] && row.status === "disputed" && (
                        <span className="text-[12px] font-poppins text-muted-foreground">Flagged</span>
                      )}
                    </div>
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