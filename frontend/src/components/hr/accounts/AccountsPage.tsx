"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Search, ChevronLeft, ChevronRight, Users, RefreshCw } from "lucide-react";
import ViewAccount from "./ViewAccount";
import CreateAccountForm from "./CreateAccountForm";
import { useHrmStore } from "@/stores/hrm.store";
import { ACCOUNT_DEPARTMENTS, formatEnumLabel } from "@/types/hrm.types";

const FILTER_OPTIONS: { label: string; value: "name" | "department" | "tier" | "status" | "designation" }[] = [
  { label: "Name", value: "name" },
  { label: "Department", value: "department" },
  { label: "Account Tier", value: "tier" },
];

function SkeletonRow() {
  return (
    <tr className="border-b border-border/50">
      {Array.from({ length: 7 }).map((_, i) => (
        <td key={i} className="py-3 px-4">
          <div className="h-4 bg-muted rounded animate-pulse w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

type ViewMode = "list" | "view" | "create" | "edit";

export default function AccountsPage() {
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterBy, setFilterBy] = useState<(typeof FILTER_OPTIONS)[number]["value"]>("name");
  const [searchDraft, setSearchDraft] = useState("");

  const {
    accounts,
    accountsMeta,
    isLoadingAccounts,
    accountsError,
    accountsFilters,
    fetchAccounts,
    setAccountsFilters,
    setAccountsPage,
  } = useHrmStore();

  useEffect(() => {
    fetchAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilter = () => {
    setAccountsFilters({ search: searchDraft.trim() || undefined, filterBy });
  };

  const clearFilters = () => {
    setSearchDraft("");
    setFilterBy("name");
    setAccountsFilters({ search: undefined, filterBy: undefined, department: undefined, tier: undefined });
  };

  const hasActiveFilters = Boolean(accountsFilters.search || accountsFilters.department || accountsFilters.tier);

  const page = accountsMeta?.page ?? accountsFilters.page;
  const totalPages = accountsMeta?.totalPages ?? 1;

  // ── Sub-views ──────────────────────────────────────────────────────────────

  if (viewMode === "create") {
    return (
      <CreateAccountForm
        mode="create"
        onBack={() => setViewMode("list")}
        onSave={() => setViewMode("list")}
      />
    );
  }

  if (viewMode === "edit" && selectedId) {
    return (
      <CreateAccountForm
        mode="edit"
        accountId={selectedId}
        onBack={() => setViewMode("view")}
        onSave={() => setViewMode("view")}
      />
    );
  }

  if (viewMode === "view" && selectedId) {
    return (
      <ViewAccount
        accountId={selectedId}
        onBack={() => setViewMode("list")}
        onEdit={() => setViewMode("edit")}
      />
    );
  }

  // ── List View ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap flex-1">
          <div className="flex items-center gap-2">
            <span className="font-poppins text-[12px] text-foreground shrink-0">Filter By:</span>
            <select
              value={filterBy}
              onChange={(e) => setFilterBy(e.target.value as typeof filterBy)}
              className="text-[12px] font-poppins text-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer h-[36px]"
            >
              {FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {filterBy === "department" ? (
            <select
              value={accountsFilters.department ?? ""}
              onChange={(e) => setAccountsFilters({ department: e.target.value || undefined })}
              className="text-[12px] font-poppins text-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer h-[36px] flex-1 min-w-[160px]"
            >
              <option value="">All Departments</option>
              {ACCOUNT_DEPARTMENTS.map((d) => (
                <option key={d} value={d}>{formatEnumLabel(d)}</option>
              ))}
            </select>
          ) : (
            <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] flex-1 min-w-[160px]">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search here..."
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleFilter()}
                className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
              />
            </div>
          )}

          <button
            onClick={handleFilter}
            className="h-[36px] px-6 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
          >
            Filter
          </button>
        </div>

        <button
          onClick={() => setViewMode("create")}
          className="h-[36px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
        >
          Create New Account
        </button>
      </div>

      {/* Table */}
      <div className="bg-card rounded-xl border border-border flex flex-col">
        <div className="px-4 sm:px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">All Employee Accounts</h3>
          {accountsError && (
            <button
              onClick={() => fetchAccounts()}
              className="flex items-center gap-1.5 text-[11px] font-poppins text-red-500 hover:underline"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {["Employee Name", "Employee ID", "Employment Type", "Department", "Designation", "Account Tier", "Action"].map((h) => (
                  <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoadingAccounts ? (
                Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)
              ) : accountsError ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center">
                    <p className="font-poppins text-[12px] text-red-500">{accountsError}</p>
                  </td>
                </tr>
              ) : accounts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <Users className="w-6 h-6 text-muted-foreground" />
                      <p className="font-poppins text-[12px] text-muted-foreground">No accounts found</p>
                      {hasActiveFilters && (
                        <button
                          onClick={clearFilters}
                          className="font-poppins text-[11px] text-primary hover:underline mt-1"
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                accounts.map((acc) => (
                  <tr
                    key={acc.id}
                    className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
                    onClick={() => { setSelectedId(acc.id); setViewMode("view"); }}
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-muted">
                          {acc.avatarUrl ? (
                            <Image src={acc.avatarUrl} alt={acc.name} width={32} height={32} className="object-cover w-full h-full" />
                          ) : (
                            <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                              <span className="text-[12px] font-poppins font-bold text-primary">{acc.name.charAt(0)}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-poppins text-[12px] font-semibold text-foreground truncate">{acc.name}</span>
                          <span className="font-poppins text-[10px] text-muted-foreground truncate">{acc.email}</span>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{acc.employeeCode ?? "—"}</td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{acc.employmentType ?? "—"}</td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{formatEnumLabel(acc.department)}</td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{acc.designation ?? "—"}</td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{formatEnumLabel(acc.tier)}</td>

                    <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2.5">
                        <button
                          title="Edit"
                          onClick={() => { setSelectedId(acc.id); setViewMode("edit"); }}
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-1 px-4 sm:px-5 py-4 flex-wrap">
            <button
              onClick={() => setAccountsPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4 text-foreground" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => setAccountsPage(p)}
                className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                  page === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
                }`}
              >
                {p}
              </button>
            ))}
            <button
              onClick={() => setAccountsPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4 text-foreground" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}