"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import type { FinanceTransaction, SaleTransaction } from "@/types/healthnet.types";

// ─── Types ────────────────────────────────────────────────────────────────────

type PerformanceTab = "appointments" | "subscriptions" | "sales";

const TABS: { value: PerformanceTab; label: string }[] = [
  { value: "appointments", label: "Appointments" },
  { value: "subscriptions", label: "Subscriptions" },
  { value: "sales", label: "Sales" },
];

type DateFilter = "today" | "week" | "month" | "all";
const DATE_FILTERS: { value: DateFilter; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_STYLE_TXN: Record<string, string> = {
  successful: "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/20",
  pending: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/20",
  failed: "text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-500/20",
};

const STATUS_STYLE_SALE: Record<string, string> = {
  paid: "text-emerald-600 dark:text-emerald-400",
  pending: "text-amber-600 dark:text-amber-400",
  refunded: "text-red-500 dark:text-red-400",
};

function Avatar({ name }: { name: string }) {
  const initial = (name ?? "?").replace(/^Dr\s+/i, "").charAt(0).toUpperCase();
  return (
    <div className="w-7 h-7 rounded-full bg-secondary shrink-0 flex items-center justify-center">
      <span className="text-[10px] font-poppins font-bold text-primary">{initial}</span>
    </div>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} className="border-b border-border">
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-3 bg-muted animate-pulse rounded-full w-full max-w-[120px]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ─── Sub-tables ───────────────────────────────────────────────────────────────

function TransactionTable({
  transactions,
  loading,
  total,
  page,
  onPageChange,
  filterValue,
  onFilterChange,
  title,
}: {
  transactions: FinanceTransaction[];
  loading: boolean;
  total: number;
  page: number;
  onPageChange: (p: number) => void;
  filterValue: DateFilter;
  onFilterChange: (f: DateFilter) => void;
  title: string;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const limit = 10;
  const totalPages = Math.ceil(total / limit);

  const pageNums: (number | "…")[] = (() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, "…", totalPages];
    if (page >= totalPages - 3) return [1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, "…", page - 1, page, page + 1, "…", totalPages];
  })();

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[14px] font-poppins font-semibold text-foreground">{title}</p>
        <div className="relative">
          <button
            onClick={() => setFilterOpen((o) => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-[8px] text-[12px] font-poppins text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_4px_rgba(0,0,0,0.2)] hover:border-primary/40 transition-colors"
          >
            {DATE_FILTERS.find((f) => f.value === filterValue)?.label}
            <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${filterOpen ? "rotate-180" : ""}`} />
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-[8px] shadow-[0_4px_16px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] overflow-hidden min-w-[130px]">
                {DATE_FILTERS.map((f) => (
                  <button
                    key={f.value}
                    onClick={() => { onFilterChange(f.value); onPageChange(1); setFilterOpen(false); }}
                    className={`w-full text-left px-3.5 py-2 text-[12px] font-poppins transition-colors ${
                      filterValue === f.value 
                        ? "bg-primary/8 text-primary font-semibold" 
                        : "text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto rounded-[12px] border border-border">
        <table className="min-w-[800px] w-full">
          <thead>
            <tr className="bg-muted/30 border-b border-border">
              {["No", "Payer Name", "Payment Mode", "Bank", "Amount", "Description", "Date", "Status"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows cols={8} />
            ) : transactions.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-[13px] font-poppins text-muted-foreground">
                  No transactions found.
                </td>
              </tr>
            ) : (
              transactions.map((row, idx) => {
                const statusKey = (row.status ?? "").toLowerCase();
                return (
                  <tr key={row.id} className={`border-b border-border hover:bg-muted/50 transition-colors ${idx % 2 !== 0 ? "bg-muted/20" : ""}`}>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">{(page - 1) * limit + idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={row.payerName ?? "?"} />
                        <span className="text-[12px] font-poppins font-medium text-foreground whitespace-nowrap">{row.payerName ?? "—"}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">{row.paymentMode ?? "—"}</td>
                    <td className="px-4 py-3 text-[11px] font-poppins text-muted-foreground whitespace-pre-line leading-tight">{row.bank ?? "—"}</td>
                    <td className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground whitespace-nowrap">
                      {row.currency ?? ""} {row.amount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">{row.description}</td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{row.date ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2.5 py-1 rounded-[6px] text-[11px] font-poppins font-semibold capitalize ${STATUS_STYLE_TXN[statusKey] ?? "text-muted-foreground bg-muted"}`}>
                        {row.status ?? "—"}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-card rounded-[12px] border border-border p-3.5 h-24 animate-pulse bg-muted" />
          ))
        ) : transactions.length === 0 ? (
          <div className="text-center py-8 text-[13px] font-poppins text-muted-foreground">No transactions found.</div>
        ) : (
          transactions.map((row) => {
            const statusKey = (row.status ?? "").toLowerCase();
            return (
              <div key={row.id} className="bg-card rounded-[12px] border border-border p-3.5 shadow-[0_1px_6px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_6px_rgba(0,0,0,0.2)]">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Avatar name={row.payerName ?? "?"} />
                    <span className="text-[13px] font-poppins font-semibold text-foreground">{row.payerName ?? "—"}</span>
                  </div>
                  <span className={`px-2.5 py-1 rounded-[6px] text-[11px] font-poppins font-semibold capitalize ${STATUS_STYLE_TXN[statusKey] ?? "text-muted-foreground bg-muted"}`}>
                    {row.status ?? "—"}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-1.5 mt-2">
                  <div>
                    <p className="text-[10px] font-poppins text-muted-foreground">Amount</p>
                    <p className="text-[12px] font-poppins font-semibold text-foreground">{row.currency} {row.amount.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-poppins text-muted-foreground">Payment Mode</p>
                    <p className="text-[12px] font-poppins text-muted-foreground">{row.paymentMode ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-poppins text-muted-foreground">Description</p>
                    <p className="text-[12px] font-poppins text-muted-foreground">{row.description}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-poppins text-muted-foreground">Date</p>
                    <p className="text-[12px] font-poppins text-muted-foreground">{row.date ?? "—"}</p>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1.5 pt-4">
          <button 
            onClick={() => onPageChange(Math.max(1, page - 1))} 
            disabled={page === 1}
            className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          {pageNums.map((n, idx) =>
            n === "…" ? (
              <span key={`e-${idx}`} className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-muted-foreground">…</span>
            ) : (
              <button 
                key={n} 
                onClick={() => onPageChange(n as number)}
                className={`w-7 h-7 flex items-center justify-center rounded-[6px] text-[12px] font-poppins font-medium transition-colors ${
                  page === n ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:border-primary hover:text-primary"
                }`}
              >
                {n}
              </button>
            )
          )}
          <button 
            onClick={() => onPageChange(Math.min(totalPages, page + 1))} 
            disabled={page === totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function SalesTable({
  sales,
  loading,
  total,
  page,
  onPageChange,
  filterValue,
  onFilterChange,
}: {
  sales: SaleTransaction[];
  loading: boolean;
  total: number;
  page: number;
  onPageChange: (p: number) => void;
  filterValue: DateFilter;
  onFilterChange: (f: DateFilter) => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const limit = 10;
  const totalPages = Math.ceil(total / limit);

  const pageNums: (number | "…")[] = (() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, "…", totalPages];
    if (page >= totalPages - 3) return [1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, "…", page - 1, page, page + 1, "…", totalPages];
  })();

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[14px] font-poppins font-semibold text-foreground">Sales History</p>
        <div className="relative">
          <button
            onClick={() => setFilterOpen((o) => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-[8px] text-[12px] font-poppins text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_4px_rgba(0,0,0,0.2)] hover:border-primary/40 transition-colors"
          >
            {DATE_FILTERS.find((f) => f.value === filterValue)?.label}
            <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${filterOpen ? "rotate-180" : ""}`} />
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-[8px] shadow-[0_4px_16px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] overflow-hidden min-w-[130px]">
                {DATE_FILTERS.map((f) => (
                  <button
                    key={f.value}
                    onClick={() => { onFilterChange(f.value); onPageChange(1); setFilterOpen(false); }}
                    className={`w-full text-left px-3.5 py-2 text-[12px] font-poppins transition-colors ${
                      filterValue === f.value 
                        ? "bg-primary/8 text-primary font-semibold" 
                        : "text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto rounded-[12px] border border-border">
        <table className="min-w-[700px] w-full">
          <thead>
            <tr className="bg-muted/30 border-b border-border">
              {["No", "Order ID", "Date", "Status", "Price", "Customer"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows cols={6} />
            ) : sales.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[13px] font-poppins text-muted-foreground">
                  No sales found.
                </td>
              </tr>
            ) : (
              sales.map((row, idx) => {
                const statusKey = (row.status ?? "").toLowerCase();
                return (
                  <tr key={row.id} className={`border-b border-border hover:bg-muted/50 transition-colors ${idx % 2 !== 0 ? "bg-muted/20" : ""}`}>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">{(page - 1) * limit + idx + 1}</td>
                    <td className="px-4 py-3 text-[12px] font-poppins font-medium text-foreground">{row.orderId ?? "—"}</td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{row.date ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[12px] font-poppins font-semibold capitalize ${STATUS_STYLE_SALE[statusKey] ?? "text-muted-foreground"}`}>
                        {row.status ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground whitespace-nowrap">
                      {row.currency ?? ""} {row.price.toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={row.customerName ?? "?"} />
                        <div>
                          <p className="text-[12px] font-poppins font-medium text-foreground whitespace-nowrap">{row.customerName ?? "—"}</p>
                          <p className="text-[11px] font-poppins text-muted-foreground truncate max-w-[160px]">{row.customerEmail ?? "—"}</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-card rounded-[12px] border border-border p-3.5 h-24 animate-pulse bg-muted" />
          ))
        ) : sales.length === 0 ? (
          <div className="text-center py-8 text-[13px] font-poppins text-muted-foreground">No sales found.</div>
        ) : (
          sales.map((row) => {
            const statusKey = (row.status ?? "").toLowerCase();
            return (
              <div key={row.id} className="bg-card rounded-[12px] border border-border p-3.5 shadow-[0_1px_6px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_6px_rgba(0,0,0,0.2)]">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Avatar name={row.customerName ?? "?"} />
                    <div>
                      <p className="text-[13px] font-poppins font-semibold text-foreground">{row.customerName ?? "—"}</p>
                      <p className="text-[11px] font-poppins text-muted-foreground">{row.customerEmail ?? "—"}</p>
                    </div>
                  </div>
                  <span className={`text-[12px] font-poppins font-semibold capitalize ${STATUS_STYLE_SALE[statusKey] ?? "text-muted-foreground"}`}>
                    {row.status ?? "—"}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 mt-2">
                  <div>
                    <p className="text-[10px] font-poppins text-muted-foreground">Order ID</p>
                    <p className="text-[12px] font-poppins font-medium text-foreground">{row.orderId ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-poppins text-muted-foreground">Price</p>
                    <p className="text-[12px] font-poppins font-semibold text-foreground">{row.currency} {row.price.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-poppins text-muted-foreground">Date</p>
                    <p className="text-[12px] font-poppins text-muted-foreground">{row.date ?? "—"}</p>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1.5 pt-4">
          <button 
            onClick={() => onPageChange(Math.max(1, page - 1))} 
            disabled={page === 1}
            className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          {pageNums.map((n, idx) =>
            n === "…" ? (
              <span key={`e-${idx}`} className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-muted-foreground">…</span>
            ) : (
              <button 
                key={n} 
                onClick={() => onPageChange(n as number)}
                className={`w-7 h-7 flex items-center justify-center rounded-[6px] text-[12px] font-poppins font-medium transition-colors ${
                  page === n ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:border-primary hover:text-primary"
                }`}
              >
                {n}
              </button>
            )
          )}
          <button 
            onClick={() => onPageChange(Math.min(totalPages, page + 1))} 
            disabled={page === totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function FinancePerformanceOverview() {
  const [activeTab, setActiveTab] = useState<PerformanceTab>("appointments");

  // Per-tab pagination and filter state
  const [apptPage, setApptPage] = useState(1);
  const [apptFilter, setApptFilter] = useState<DateFilter>("today");

  const [subPage, setSubPage] = useState(1);
  const [subFilter, setSubFilter] = useState<DateFilter>("today");

  const [salesPage, setSalesPage] = useState(1);
  const [salesFilter, setSalesFilter] = useState<DateFilter>("today");

  const {
    financeAppointmentsHistory,
    financeAppointmentsHistoryLoading,
    fetchFinanceAppointmentsHistory,
    financeSubscriptionsHistory,
    financeSubscriptionsHistoryLoading,
    fetchFinanceSubscriptionsHistory,
    financeSalesHistory,
    financeSalesHistoryLoading,
    fetchFinanceSalesHistory,
  } = useHealthnetStore();

  // Fetch when tab / page / filter changes
  useEffect(() => {
    if (activeTab === "appointments") {
      fetchFinanceAppointmentsHistory({ page: apptPage, limit: 10, date: apptFilter });
    }
  }, [activeTab, apptPage, apptFilter, fetchFinanceAppointmentsHistory]);

  useEffect(() => {
    if (activeTab === "subscriptions") {
      fetchFinanceSubscriptionsHistory({ page: subPage, limit: 10, date: subFilter });
    }
  }, [activeTab, subPage, subFilter, fetchFinanceSubscriptionsHistory]);

  useEffect(() => {
    if (activeTab === "sales") {
      fetchFinanceSalesHistory({ page: salesPage, limit: 10, date: salesFilter });
    }
  }, [activeTab, salesPage, salesFilter, fetchFinanceSalesHistory]);

  return (
    <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5 sm:p-6">
      <h2 className="text-[17px] font-poppins font-bold text-foreground mb-4">Performance Overview</h2>

      {/* Tabs */}
      <div className="flex border-b border-border gap-1 mb-5 overflow-x-auto scrollbar-hide">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={`relative px-4 py-2.5 text-[13px] font-poppins font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.value 
                ? "text-primary dark:text-white" 
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {activeTab === tab.value && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary dark:bg-white rounded-t-full" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === "appointments" && (
        <TransactionTable
          title="Appointments"
          transactions={financeAppointmentsHistory?.transactions ?? []}
          loading={financeAppointmentsHistoryLoading}
          total={financeAppointmentsHistory?.total ?? 0}
          page={apptPage}
          onPageChange={setApptPage}
          filterValue={apptFilter}
          onFilterChange={(f) => { setApptFilter(f); setApptPage(1); }}
        />
      )}
      {activeTab === "subscriptions" && (
        <TransactionTable
          title="Subscriptions"
          transactions={financeSubscriptionsHistory?.transactions ?? []}
          loading={financeSubscriptionsHistoryLoading}
          total={financeSubscriptionsHistory?.total ?? 0}
          page={subPage}
          onPageChange={setSubPage}
          filterValue={subFilter}
          onFilterChange={(f) => { setSubFilter(f); setSubPage(1); }}
        />
      )}
      {activeTab === "sales" && (
        <SalesTable
          sales={financeSalesHistory?.sales ?? []}
          loading={financeSalesHistoryLoading}
          total={financeSalesHistory?.total ?? 0}
          page={salesPage}
          onPageChange={setSalesPage}
          filterValue={salesFilter}
          onFilterChange={(f) => { setSalesFilter(f); setSalesPage(1); }}
        />
      )}
    </div>
  );
}