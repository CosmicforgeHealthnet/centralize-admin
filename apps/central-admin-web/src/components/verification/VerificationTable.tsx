"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { useVerificationStore } from "@/stores/verification.store";
import { useStuckDoctorsStore } from "@/stores/useStuckDoctorsStore";

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  Pending:  { bg: "rgba(232,182,0,0.12)",  text: "#E8B600" },
  Approved: { bg: "rgba(13,165,63,0.12)",  text: "#0DA53F" },
  Failed:   { bg: "rgba(246,69,69,0.12)",  text: "#F64545" },
};

const RISK_STYLES: Record<string, { bg: string; text: string }> = {
  Low:    { bg: "rgba(13,165,63,0.12)",  text: "#0DA53F" },
  Medium: { bg: "rgba(232,182,0,0.12)",  text: "#E8B600" },
  High:   { bg: "rgba(246,69,69,0.12)",  text: "#F64545" },
};

const ROLE_DISPLAY: Record<string, string> = {
  Doctors:    "Doctor",
  Labs:       "Lab",
  Pharmacies: "Pharmacy",
  Logistics:  "Logistics",
};

// ─── Skeleton Row ─────────────────────────────────────────────────────────────

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="border-b border-border/50">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="py-3 px-4 sm:px-5">
          <div className="h-4 bg-gray-100 rounded animate-pulse w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

// ─── Stuck Doctors Table ──────────────────────────────────────────────────────

function StuckDoctorsTable() {
  const router = useRouter();
  const { doctors, stats, pagination, isLoading, error, fetch, setPage, clearError } = useStuckDoctorsStore();
  const [searchDraft, setSearchDraft] = useState("");

  useEffect(() => {
    fetch();
  }, []);

  const currentPage = pagination?.currentPage ?? 1;
  const totalPages = pagination?.totalPages ?? 1;
  const totalItems = pagination?.totalItems ?? 0;

  const pageNumbers = (): (number | "...")[] => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | "...")[] = [1, 2, 3];
    if (currentPage > 4) pages.push("...");
    if (currentPage > 3 && currentPage < totalPages - 2) pages.push(currentPage);
    if (currentPage < totalPages - 3) pages.push("...");
    pages.push(totalPages - 1, totalPages);
    return [...new Set(pages)];
  };

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <h2 className="text-[15px] font-poppins font-semibold text-foreground">
          Stuck Doctors
          {pagination && (
            <span className="ml-2 text-[12px] font-normal text-muted-foreground">
              ({totalItems} total)
            </span>
          )}
        </h2>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] flex-1 sm:w-[200px] sm:flex-none">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search doctors..."
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
            />
          </div>
          <button
            onClick={() => fetch()}
            className="h-[36px] px-5 bg-primary text-white text-[13px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* ── Stats Banner ── */}
      {stats && (
        <div className="flex flex-wrap gap-3 px-4 sm:px-5 pb-3">
          <span className="text-[12px] font-poppins text-muted-foreground">
            Total Stuck: <span className="font-semibold text-foreground">{stats.totalStuck}</span>
          </span>
          <span className="text-[12px] font-poppins text-muted-foreground">
            No Profile: <span className="font-semibold text-red-500">{stats.noProfile}</span>
          </span>
          <span className="text-[12px] font-poppins text-muted-foreground">
            Has Profile: <span className="font-semibold text-amber-500">{stats.hasProfile}</span>
          </span>
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <div className="mx-4 mb-3 px-4 py-2.5 rounded-lg bg-red-50 border border-red-200 flex items-center justify-between">
          <span className="text-[12px] font-poppins text-red-600">{error}</span>
          <button
            onClick={clearError}
            className="text-[11px] font-poppins text-red-400 hover:text-red-600 ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead>
            <tr className="border-b border-border">
              {["User", "Email", "Registered", "Profile Status", "Days Stuck", "Action"].map((h) => (
                <th
                  key={h}
                  className="text-left py-2.5 px-4 sm:px-5 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={6} />)
            ) : doctors.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  No stuck doctors found
                </td>
              </tr>
            ) : (
              doctors.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                >
                  <td className="py-3 px-4 sm:px-5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-muted flex items-center justify-center">
                        <span className="text-[12px] font-poppins font-bold text-primary">
                          {row.fullName?.charAt(0).toUpperCase() || "?"}
                        </span>
                      </div>
                      <span className="text-[13px] font-poppins text-foreground whitespace-nowrap">
                        {row.fullName || "—"}
                      </span>
                    </div>
                  </td>

                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground">
                    {row.email}
                  </td>

                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground whitespace-nowrap">
                    {row.createdAt ? new Date(row.createdAt).toLocaleDateString("en-GB") : "—"}
                  </td>

                  <td className="py-3 px-4 sm:px-5">
                    <span
                      className={`inline-flex items-center px-3 py-1 rounded-full text-[12px] font-poppins font-semibold whitespace-nowrap ${
                        row.hasProfile
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400"
                          : "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400"
                      }`}
                    >
                      {row.hasProfile ? "Has Profile" : "No Profile"}
                    </span>
                  </td>

                  <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground whitespace-nowrap">
                    <span className={row.daysStuck > 30 ? "text-red-500 font-semibold" : ""}>
                      {row.daysStuck} days
                    </span>
                  </td>

                  <td className="py-3 px-4 sm:px-5">
                    <button
                      onClick={() =>
                        router.push(`/dashboard/verification/${row.id}?role=Stuck`)
                      }
                      className="h-[30px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors whitespace-nowrap"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {pagination && totalPages > 1 && (
        <div className="flex items-center justify-end gap-1 px-4 sm:px-5 py-4 flex-wrap">
          <button
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage === 1}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-foreground" />
          </button>

          {pageNumbers().map((p, i) =>
            p === "..." ? (
              <span
                key={`el-${i}`}
                className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-muted-foreground"
              >
                ...
              </span>
            ) : (
              <button
                key={p}
                onClick={() => setPage(p as number)}
                className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                  currentPage === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
                }`}
              >
                {p}
              </button>
            )
          )}

          <button
            onClick={() => setPage(currentPage + 1)}
            disabled={currentPage === totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-foreground" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Verification Table ──────────────────────────────────────────────────────

function VerificationRequestsTable() {
  const router = useRouter();
  const requests = useVerificationStore((s) => s.requests);
  const pagination = useVerificationStore((s) => s.pagination);
  const filters = useVerificationStore((s) => s.filters);
  const activeRole = useVerificationStore((s) => s.activeRole);
  const isLoading = useVerificationStore((s) => s.isLoadingList);
  const error = useVerificationStore((s) => s.error);
  const setFilters = useVerificationStore((s) => s.setFilters);
  const fetchList = useVerificationStore((s) => s.fetchList);
  const clearError = useVerificationStore((s) => s.clearError);

  useEffect(() => {
    fetchList();
  }, [activeRole, filters.page]);

  const handleSearch = (value: string) => {
    setFilters({ search: value, page: 1 });
    fetchList();
  };

  const currentPage = pagination?.currentPage ?? 1;
  const totalPages = pagination?.totalPages ?? 1;
  const totalItems = pagination?.totalItems ?? 0;

  const pageNumbers = (): (number | "...")[] => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | "...")[] = [1, 2, 3];
    if (currentPage > 4) pages.push("...");
    if (currentPage > 3 && currentPage < totalPages - 2) pages.push(currentPage);
    if (currentPage < totalPages - 3) pages.push("...");
    pages.push(totalPages - 1, totalPages);
    return [...new Set(pages)];
  };

  const [searchDraft, setSearchDraft] = useState(filters.search);

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <h2 className="text-[15px] font-poppins font-semibold text-foreground">
          Verification Requests
          {pagination && (
            <span className="ml-2 text-[12px] font-normal text-muted-foreground">
              ({totalItems} total)
            </span>
          )}
        </h2>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] flex-1 sm:w-[200px] sm:flex-none">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search here..."
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch(searchDraft)}
              className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
            />
          </div>
          <button
            onClick={() => handleSearch(searchDraft)}
            className="h-[36px] px-5 bg-primary text-white text-[13px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
          >
            Search
          </button>
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="mx-4 mb-3 px-4 py-2.5 rounded-lg bg-red-50 border border-red-200 flex items-center justify-between">
          <span className="text-[12px] font-poppins text-red-600">{error}</span>
          <button
            onClick={clearError}
            className="text-[11px] font-poppins text-red-400 hover:text-red-600 ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead>
            <tr className="border-b border-border">
              {["User", "Role", "Verification Type", "License ID", "Specialty", "Status", "Submitted Date", "Risk Indicator", "Action"].map((h) => (
                <th
                  key={h}
                  className="text-left py-2.5 px-4 sm:px-5 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={9} />)
            ) : requests.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  No results found
                </td>
              </tr>
            ) : (
              requests.map((row) => {
                const st = STATUS_STYLES[row.status] ?? STATUS_STYLES["Pending"];
                const ri = RISK_STYLES[row.riskIndicator] ?? RISK_STYLES["Low"];
                return (
                  <tr
                    key={row.id}
                    className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                  >
                    <td className="py-3 px-4 sm:px-5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-muted">
                          {row.profileImageUrl ? (
                            <Image
                              src={row.profileImageUrl}
                              alt={row.user}
                              width={32}
                              height={32}
                              className="object-cover w-full h-full"
                            />
                          ) : (
                            <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                              <span className="text-[12px] font-poppins font-bold text-primary">
                                {row.user.charAt(0).toUpperCase()}
                              </span>
                            </div>
                          )}
                        </div>
                        <span className="text-[13px] font-poppins text-foreground whitespace-nowrap">
                          {row.user}
                        </span>
                      </div>
                    </td>

                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground whitespace-nowrap">
                      {ROLE_DISPLAY[row.role] ?? row.role}
                    </td>

                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground whitespace-nowrap">
                      {row.verificationType}
                    </td>

                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground">
                      {row.licenseId}
                    </td>

                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground">
                      {row.specialty || "—"}
                    </td>

                    <td className="py-3 px-4 sm:px-5">
                      <span
                        className="inline-flex items-center px-3 py-1 rounded-full text-[12px] font-poppins font-semibold whitespace-nowrap"
                        style={{ backgroundColor: st.bg, color: st.text }}
                      >
                        {row.status}
                      </span>
                    </td>

                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground whitespace-nowrap">
                      {row.submittedDate ?? "—"}
                    </td>

                    <td className="py-3 px-4 sm:px-5">
                      <span
                        className="inline-flex items-center px-3 py-1 rounded-full text-[12px] font-poppins font-semibold whitespace-nowrap"
                        style={{ backgroundColor: ri.bg, color: ri.text }}
                      >
                        {row.riskIndicator}
                      </span>
                    </td>

                    <td className="py-3 px-4 sm:px-5">
                      <button
                        onClick={() =>
                          router.push(
                            `/dashboard/verification/${row.id}?role=${row.role}`
                          )
                        }
                        className="h-[30px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors whitespace-nowrap"
                      >
                        Review
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
        <div className="flex items-center justify-end gap-1 px-4 sm:px-5 py-4 flex-wrap">
          <button
            onClick={() => setFilters({ page: currentPage - 1 })}
            disabled={currentPage === 1}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-foreground" />
          </button>

          {pageNumbers().map((p, i) =>
            p === "..." ? (
              <span
                key={`el-${i}`}
                className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-muted-foreground"
              >
                ...
              </span>
            ) : (
              <button
                key={p}
                onClick={() => setFilters({ page: p as number })}
                className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                  currentPage === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
                }`}
              >
                {p}
              </button>
            )
          )}

          <button
            onClick={() => setFilters({ page: currentPage + 1 })}
            disabled={currentPage === totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-foreground" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function VerificationTable() {
  const activeRole = useVerificationStore((s) => s.activeRole);

  if (activeRole === "Stuck") {
    return <StuckDoctorsTable />;
  }

  return <VerificationRequestsTable />;
}