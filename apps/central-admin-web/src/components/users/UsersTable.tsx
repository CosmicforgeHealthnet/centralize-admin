"use client";

import { useEffect, useState, useCallback } from "react";
import UserDetailDrawer from "@/components/users/UserDetailDrawer";
import {
  Search, ChevronLeft, ChevronRight, X,
  ArrowUpDown, ArrowUp, ArrowDown,
  Trash2, ShieldAlert, CheckSquare, Square,
  SlidersHorizontal, ChevronDown,
} from "lucide-react";
import { useUsersStore } from "@/stores/users.store";

// ── Style maps ────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  active:                       { bg: "rgba(13,165,63,0.12)",    text: "#0DA53F", label: "Active" },
  doctor_active:                { bg: "rgba(13,165,63,0.12)",    text: "#0DA53F", label: "Dr. Active" },
  pharmacy_active:              { bg: "rgba(13,165,63,0.12)",    text: "#0DA53F", label: "Ph. Active" },
  locked:                       { bg: "rgba(246,69,69,0.12)",    text: "#F64545", label: "Locked" },
  pending_email_verification:   { bg: "rgba(245,158,11,0.12)",   text: "#F59E0B", label: "Pending Email" },
  pending_doctor_verification:  { bg: "rgba(245,158,11,0.12)",   text: "#F59E0B", label: "Pending Doctor" },
  pending_pharmacy_verification:{ bg: "rgba(245,158,11,0.12)",   text: "#F59E0B", label: "Pending Pharmacy" },
};

const ROLE_STYLES: Record<string, { bg: string; text: string }> = {
  doctor:    { bg: "rgba(39,46,167,0.10)",   text: "#272EA7" },
  patient:   { bg: "rgba(13,165,63,0.12)",   text: "#0DA53F" },
  pharmacy:  { bg: "rgba(232,182,0,0.12)",   text: "#E8B600" },
  lab_admin: { bg: "rgba(143,144,164,0.15)", text: "#8F90A4" },
  admin:     { bg: "rgba(246,69,69,0.12)",   text: "#F64545" },
};

const VALID_STATUSES = [
  { value: "active",                        label: "Active" },
  { value: "doctor_active",                 label: "Doctor Active" },
  { value: "pharmacy_active",               label: "Pharmacy Active" },
  { value: "locked",                        label: "Locked" },
  { value: "pending_email_verification",    label: "Pending Email" },
  { value: "pending_doctor_verification",   label: "Pending Doctor" },
  { value: "pending_pharmacy_verification", label: "Pending Pharmacy" },
];

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="border-b border-border/50">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="py-3 px-4">
          <div className="h-4 bg-muted rounded-full animate-pulse" style={{ width: `${60 + (i * 17) % 60}px` }} />
        </td>
      ))}
    </tr>
  );
}

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIcon({ field, active, order }: { field: string; active: string; order: "asc" | "desc" }) {
  if (active !== field) return <ArrowUpDown className="w-3 h-3 text-muted-foreground/50 ml-1 inline-block" />;
  return order === "asc"
    ? <ArrowUp className="w-3 h-3 text-primary ml-1 inline-block" />
    : <ArrowDown className="w-3 h-3 text-primary ml-1 inline-block" />;
}

// ── Bulk action bar ───────────────────────────────────────────────────────────

function BulkBar({
  count,
  onStatusChange,
  onDeselect,
  isBusy,
}: {
  count: number;
  onStatusChange: (status: string) => void;
  onDeselect: () => void;
  isBusy: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border-b border-primary/20 animate-in slide-in-from-top-1 duration-200">
      <span className="text-[12px] font-poppins font-semibold text-primary">
        {count} selected
      </span>
      <div className="h-4 w-px bg-border" />

      {/* Bulk status dropdown */}
      <div className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          disabled={isBusy}
          className="flex items-center gap-1.5 h-[30px] px-3 bg-card border border-border rounded-lg text-[12px] font-poppins font-medium text-foreground hover:border-primary/50 transition-colors disabled:opacity-50"
        >
          <ShieldAlert className="w-3.5 h-3.5 text-muted-foreground" />
          Set Status
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        </button>
        {open && (
          <div className="absolute top-full left-0 mt-1 w-48 bg-card border border-border rounded-xl shadow-xl z-30 overflow-hidden">
            {VALID_STATUSES.map((s) => (
              <button
                key={s.value}
                onClick={() => { onStatusChange(s.value); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-[12px] font-poppins text-foreground hover:bg-muted transition-colors"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto">
        <button
          onClick={onDeselect}
          className="h-[28px] px-3 text-[11px] font-poppins text-muted-foreground hover:text-foreground border border-border rounded-lg hover:border-foreground/30 transition-colors"
        >
          Deselect all
        </button>
      </div>
    </div>
  );
}

// ── Main table ────────────────────────────────────────────────────────────────

export default function UsersTable() {
  const users         = useUsersStore((s) => s.users);
  const pagination    = useUsersStore((s) => s.pagination);
  const filters       = useUsersStore((s) => s.filters);
  const isLoading     = useUsersStore((s) => s.isLoadingUsers);
  const isBulkUpdating = useUsersStore((s) => s.isBulkUpdating);
  const error         = useUsersStore((s) => s.error);
  const setFilters    = useUsersStore((s) => s.setFilters);
  const fetch         = useUsersStore((s) => s.fetchUsers);
  const fetchUser     = useUsersStore((s) => s.fetchUser);
  const bulkUpdate    = useUsersStore((s) => s.bulkUpdateStatus);
  const clearError    = useUsersStore((s) => s.clearError);

  const [searchDraft, setSearchDraft]   = useState(filters.search);
  const [showFilters, setShowFilters]   = useState(false);
  // Scope selections to the current list, without effect-driven state resets.
  const userListKey = users.map((user) => user.id).join("\u0000");
  const [selection, setSelection] = useState<{ key: string; ids: Set<string> }>({ key: "", ids: new Set() });
  const selectedIds = selection.key === userListKey ? selection.ids : new Set<string>();
  const setSelectedIds = (update: Set<string> | ((ids: Set<string>) => Set<string>)) => {
    setSelection((current) => {
      const previous = current.key === userListKey ? current.ids : new Set<string>();
      return { key: userListKey, ids: typeof update === "function" ? update(previous) : update };
    });
  };

  // Re-fetch whenever filters change
  useEffect(() => { fetch(); }, [filters.page, filters.role, filters.status, filters.tier, filters.sortBy, filters.sortOrder]);

  const handleSearch = useCallback(() => {
    setFilters({ search: searchDraft, page: 1 });
    fetch();
  }, [searchDraft, setFilters, fetch]);

  const handleSort = (field: string) => {
    const newOrder = filters.sortBy === field && filters.sortOrder === "desc" ? "asc" : "desc";
    setFilters({ sortBy: field, sortOrder: newOrder, page: 1 });
  };

  const toggleAll = () => {
    if (selectedIds.size === users.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(users.map((u) => u.id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleBulkStatus = async (status: string) => {
    await bulkUpdate(Array.from(selectedIds), status);
    setSelectedIds(new Set());
  };

  const currentPage = pagination?.currentPage ?? 1;
  const totalPages  = pagination?.totalPages  ?? 1;
  const totalItems  = pagination?.totalItems  ?? 0;
  const allSelected = users.length > 0 && selectedIds.size === users.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  const pageNumbers = (): (number | "...")[] => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | "...")[] = [1];
    if (currentPage > 3) pages.push("...");
    for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) pages.push(i);
    if (currentPage < totalPages - 2) pages.push("...");
    pages.push(totalPages);
    return pages;
  };

  return (
    <>
      <div className="bg-card rounded-2xl border border-border flex flex-col overflow-hidden">

        {/* ── Header ── */}
        <div className="flex flex-col gap-3 px-5 pt-5 pb-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-poppins font-semibold text-foreground">
              All Users
              {pagination && (
                <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                  ({totalItems.toLocaleString()} total)
                </span>
              )}
            </h2>
            <button
              onClick={() => setShowFilters((o) => !o)}
              className={`flex items-center gap-1.5 h-[34px] px-3 rounded-xl border text-[12px] font-poppins font-medium transition-colors ${
                showFilters ? "bg-primary text-white border-primary" : "bg-muted border-border text-foreground hover:border-primary/50"
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filters
            </button>
          </div>

          {/* Search row */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-muted border border-border rounded-xl px-3 h-[38px] flex-1">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search name, email, or phone…"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="bg-transparent text-[13px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
              />
              {searchDraft && (
                <button onClick={() => { setSearchDraft(""); setFilters({ search: "", page: 1 }); fetch(); }}>
                  <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                </button>
              )}
            </div>
            <button
              onClick={handleSearch}
              className="h-[38px] px-5 bg-primary text-white text-[13px] font-poppins font-semibold rounded-xl hover:bg-primary/90 transition-colors shrink-0"
            >
              Search
            </button>
          </div>

          {/* Expanded filter row */}
          {showFilters && (
            <div className="flex flex-wrap gap-2 pt-1 border-t border-border animate-in slide-in-from-top-1 duration-200">
              {/* Role */}
              <select
                value={filters.role}
                onChange={(e) => setFilters({ role: e.target.value, page: 1 })}
                className="h-[34px] px-3 bg-muted border border-border rounded-xl text-[12px] font-poppins text-foreground outline-none cursor-pointer"
              >
                <option value="">All Roles</option>
                <option value="doctor">Doctor</option>
                <option value="patient">Patient</option>
                <option value="pharmacy">Pharmacy</option>
                <option value="lab_admin">Lab Admin</option>
              </select>

              {/* Status */}
              <select
                value={filters.status}
                onChange={(e) => setFilters({ status: e.target.value, page: 1 })}
                className="h-[34px] px-3 bg-muted border border-border rounded-xl text-[12px] font-poppins text-foreground outline-none cursor-pointer"
              >
                <option value="">All Statuses</option>
                {VALID_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>

              {/* Tier */}
              <select
                value={filters.tier}
                onChange={(e) => setFilters({ tier: e.target.value, page: 1 })}
                className="h-[34px] px-3 bg-muted border border-border rounded-xl text-[12px] font-poppins text-foreground outline-none cursor-pointer"
              >
                <option value="">All Tiers</option>
                <option value="free">Free</option>
                <option value="basic">Basic</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
              </select>

              {/* Date from */}
              <div className="flex items-center gap-1.5 h-[34px] px-3 bg-muted border border-border rounded-xl">
                <span className="text-[11px] font-poppins text-muted-foreground shrink-0">From</span>
                <input
                  type="date"
                  value={filters.dateFrom}
                  onChange={(e) => setFilters({ dateFrom: e.target.value, page: 1 })}
                  className="bg-transparent text-[12px] font-poppins text-foreground outline-none"
                />
              </div>

              {/* Date to */}
              <div className="flex items-center gap-1.5 h-[34px] px-3 bg-muted border border-border rounded-xl">
                <span className="text-[11px] font-poppins text-muted-foreground shrink-0">To</span>
                <input
                  type="date"
                  value={filters.dateTo}
                  onChange={(e) => setFilters({ dateTo: e.target.value, page: 1 })}
                  className="bg-transparent text-[12px] font-poppins text-foreground outline-none"
                />
              </div>

              {/* Sort */}
              <select
                value={`${filters.sortBy}-${filters.sortOrder}`}
                onChange={(e) => {
                  const [by, order] = e.target.value.split("-") as [string, "asc" | "desc"];
                  setFilters({ sortBy: by, sortOrder: order, page: 1 });
                }}
                className="h-[34px] px-3 bg-muted border border-border rounded-xl text-[12px] font-poppins text-foreground outline-none cursor-pointer"
              >
                <option value="createdAt-desc">Newest first</option>
                <option value="createdAt-asc">Oldest first</option>
                <option value="fullName-asc">Name A→Z</option>
                <option value="fullName-desc">Name Z→A</option>
                <option value="email-asc">Email A→Z</option>
                <option value="role-asc">Role A→Z</option>
                <option value="status-asc">Status A→Z</option>
              </select>

              {/* Reset */}
              {(filters.role || filters.status || filters.tier || filters.dateFrom || filters.dateTo) && (
                <button
                  onClick={() => { useUsersStore.getState().resetFilters(); fetch(); }}
                  className="h-[34px] px-3 text-[12px] font-poppins text-destructive border border-destructive/30 rounded-xl hover:bg-destructive/5 transition-colors"
                >
                  Reset filters
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Error banner ── */}
        {error && (
          <div className="mx-5 mb-3 px-4 py-2.5 rounded-xl bg-destructive/5 border border-destructive/20 flex items-center justify-between">
            <span className="text-[12px] font-poppins text-destructive">{error}</span>
            <button onClick={clearError} className="text-[11px] font-poppins text-destructive/60 hover:text-destructive ml-4 transition-colors">
              Dismiss
            </button>
          </div>
        )}

        {/* ── Bulk action bar ── */}
        {selectedIds.size > 0 && (
          <BulkBar
            count={selectedIds.size}
            onStatusChange={handleBulkStatus}
            onDeselect={() => setSelectedIds(new Set())}
            isBusy={isBulkUpdating}
          />
        )}

        {/* ── Table ── */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {/* Checkbox */}
                <th className="py-3 px-4 w-10">
                  <button onClick={toggleAll} className="flex items-center justify-center">
                    {allSelected ? (
                      <CheckSquare className="w-4 h-4 text-primary" />
                    ) : someSelected ? (
                      <div className="w-4 h-4 rounded border-2 border-primary bg-primary/20 flex items-center justify-center">
                        <div className="w-2 h-0.5 bg-primary rounded-full" />
                      </div>
                    ) : (
                      <Square className="w-4 h-4 text-muted-foreground" />
                    )}
                  </button>
                </th>
                {[
                  { key: "fullName",  label: "User" },
                  { key: "role",      label: "Role" },
                  { key: "status",    label: "Status" },
                  { key: null,        label: "Tier" },
                  { key: null,        label: "Phone" },
                  { key: null,        label: "Last Login" },
                  { key: "createdAt", label: "Joined" },
                  { key: null,        label: "Action" },
                ].map(({ key, label }) => (
                  <th
                    key={label}
                    onClick={key ? () => handleSort(key) : undefined}
                    className={`text-left py-3 px-4 text-[11px] font-poppins font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap select-none ${key ? "cursor-pointer hover:text-foreground transition-colors" : ""}`}
                  >
                    {label}
                    {key && <SortIcon field={key} active={filters.sortBy} order={filters.sortOrder} />}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={9} />)
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-16">
                    <div className="flex flex-col items-center gap-2">
                      <Search className="w-8 h-8 text-muted-foreground/30" />
                      <span className="text-[13px] font-poppins text-muted-foreground">No users found</span>
                      <span className="text-[11px] font-poppins text-muted-foreground/60">Try adjusting your filters</span>
                    </div>
                  </td>
                </tr>
              ) : (
                users.map((user) => {
                  const rs       = ROLE_STYLES[user.role]     ?? { bg: "rgba(143,144,164,0.15)", text: "#8F90A4" };
                  const ss       = STATUS_STYLES[user.status] ?? { bg: "rgba(143,144,164,0.15)", text: "#8F90A4", label: user.status };
                  const selected = selectedIds.has(user.id);

                  return (
                    <tr
                      key={user.id}
                      className={`border-b border-border/50 transition-colors ${selected ? "bg-primary/4" : "hover:bg-muted/20"}`}
                    >
                      {/* Checkbox */}
                      <td className="py-3 px-4">
                        <button onClick={() => toggleOne(user.id)} className="flex items-center justify-center">
                          {selected
                            ? <CheckSquare className="w-4 h-4 text-primary" />
                            : <Square className="w-4 h-4 text-muted-foreground hover:text-foreground transition-colors" />
                          }
                        </button>
                      </td>

                      {/* User */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 ring-1 ring-primary/10">
                            <span className="text-[12px] font-poppins font-bold text-primary">
                              {user.fullName.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <div className="flex flex-col min-w-0">
                            <span className="text-[13px] font-poppins font-medium text-foreground truncate max-w-[140px]">{user.fullName}</span>
                            <span className="text-[11px] font-poppins text-muted-foreground truncate max-w-[140px]">{user.email}</span>
                          </div>
                        </div>
                      </td>

                      {/* Role */}
                      <td className="py-3 px-4">
                        <span className="inline-flex px-2.5 py-1 rounded-full text-[11px] font-poppins font-semibold capitalize whitespace-nowrap" style={{ backgroundColor: rs.bg, color: rs.text }}>
                          {user.role.replace("_", " ")}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4">
                        <span className="inline-flex px-2.5 py-1 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap" style={{ backgroundColor: ss.bg, color: ss.text }}>
                          {ss.label}
                        </span>
                      </td>

                      {/* Tier */}
                      <td className="py-3 px-4 text-[13px] font-poppins text-foreground capitalize">{user.tier ?? "—"}</td>

                      {/* Phone */}
                      <td className="py-3 px-4 text-[13px] font-poppins text-foreground">{user.phoneNumber ?? "—"}</td>

                      {/* Last Login */}
                      <td className="py-3 px-4 text-[13px] font-poppins text-foreground whitespace-nowrap">
                        {user.lastLoginAt
                          ? new Date(user.lastLoginAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
                          : <span className="text-muted-foreground">Never</span>}
                      </td>

                      {/* Joined */}
                      <td className="py-3 px-4 text-[13px] font-poppins text-foreground whitespace-nowrap">
                        {new Date(user.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                      </td>

                      {/* Action */}
                      <td className="py-3 px-4">
                        <button
                          onClick={() => fetchUser(user.id)}
                          className="h-[30px] px-4 bg-primary/10 text-primary text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary hover:text-white transition-all duration-200 whitespace-nowrap"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ── */}
        {pagination && totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-border">
            <span className="text-[12px] font-poppins text-muted-foreground hidden sm:block">
              Page {currentPage} of {totalPages}
            </span>
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setFilters({ page: currentPage - 1 })}
                disabled={currentPage === 1}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4 text-foreground" />
              </button>

              {pageNumbers().map((p, i) =>
                p === "..." ? (
                  <span key={`el-${i}`} className="w-8 h-8 flex items-center justify-center text-[12px] font-poppins text-muted-foreground">…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setFilters({ page: p as number })}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg text-[12px] font-poppins font-semibold transition-all ${
                      currentPage === p ? "bg-primary text-white shadow-sm" : "text-foreground hover:bg-muted"
                    }`}
                  >
                    {p}
                  </button>
                )
              )}

              <button
                onClick={() => setFilters({ page: currentPage + 1 })}
                disabled={currentPage === totalPages}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-4 h-4 text-foreground" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Drawer - no props needed */}
      <UserDetailDrawer />
    </>
  );
}