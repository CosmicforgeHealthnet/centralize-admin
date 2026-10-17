"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { TrendingUp, TrendingDown, Search, ChevronDown, ChevronLeft, ChevronRight, CalendarX, X } from "lucide-react";
import AttendanceDetail from "./AttendanceDetail";
import { useHrmStore } from "@/stores/hrm.store";
import { attendanceService } from "@/lib/hrm.service";
import { AttendanceStatus } from "@/types/hrm.types";

// ─── Static config ────────────────────────────────────────────────────────────

const DEPARTMENTS = [
  "FINANCE",
  "DEVELOPMENT",
  "CUSTOMER_CARE",
  "MARKETING",
  "SOCIAL_MEDIA",
  "EXECUTIVE",
  "MANAGEMENT",
] as const;

function formatEnumLabel(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

const DEPARTMENTS_FILTER = [
  { value: "", label: "All Departments" },
  ...DEPARTMENTS.map((d) => ({ value: d, label: formatEnumLabel(d) })),
];

const STATUS_STYLES: Record<AttendanceStatus, { bg: string; text: string; label: string }> = {
  PRESENT: { bg: "rgba(13,165,63,0.12)", text: "#0DA53F", label: "Present" },
  LATE:    { bg: "rgba(232,182,0,0.12)", text: "#E8B600", label: "Late" },
  ABSENT:  { bg: "rgba(246,69,69,0.12)", text: "#F64545", label: "Absent" },
};

function formatChange(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}%`;
}

function StatIcon({ type }: { type: string }) {
  const cls = "w-5 h-5 text-primary";
  if (type === "users") return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
  if (type === "calendar") return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function StatCard({
  icon, label, sub, value, change, subtitle,
}: { icon: string; label: string; sub: string; value: string; change: number; subtitle: string }) {
  const isUp = change >= 0;
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <StatIcon type={icon} />
        </div>
        <div className="flex flex-col">
          <span className="font-poppins text-[11px] font-semibold text-primary leading-tight">{label}</span>
          <span className="font-poppins text-[10px] text-muted-foreground leading-tight">{sub}</span>
        </div>
      </div>
      <span className="font-poppins text-[26px] font-bold text-foreground leading-none">{value}</span>
      <div className="flex items-center gap-1 flex-wrap">
        {isUp
          ? <TrendingUp className="w-3 h-3 text-green-500 shrink-0" />
          : <TrendingDown className="w-3 h-3 text-red-500 shrink-0" />
        }
        <span className={`font-poppins text-[10px] font-semibold ${isUp ? "text-green-500" : "text-red-500"}`}>
          {formatChange(change)}
        </span>
        <span className="font-poppins text-[10px] text-muted-foreground">{subtitle}</span>
      </div>
    </div>
  );
}

function StatCardError({ icon, label, sub, onRetry }: { icon: string; label: string; sub: string; onRetry: () => void }) {
  return (
    <div className="bg-card rounded-xl border border-destructive/30 p-4 flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0">
          <StatIcon type={icon} />
        </div>
        <div className="flex flex-col">
          <span className="font-poppins text-[11px] font-semibold text-foreground leading-tight">{label}</span>
          <span className="font-poppins text-[10px] text-muted-foreground leading-tight">{sub}</span>
        </div>
      </div>
      <span className="font-poppins text-[13px] font-semibold text-destructive">Couldn't load</span>
      <button
        onClick={onRetry}
        className="font-poppins text-[10px] font-semibold text-primary hover:underline text-left"
      >
        Retry
      </button>
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-border/50">
      {Array.from({ length: 9 }).map((_, i) => (
        <td key={i} className="py-3 px-4">
          <div className="h-4 bg-muted rounded animate-pulse w-full max-w-[100px]" />
        </td>
      ))}
    </tr>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [downloading, setDownloading] = useState(false);

  const {
    attendanceStats: stats, isLoadingAttendanceStats: isLoadingStats, fetchAttendanceStats: fetchStats,
    attendanceRecords: records, attendanceMeta: meta, isLoadingAttendanceList: isLoadingList,
    attendanceFilters: filters, fetchAttendance, setAttendanceFilters: setFilters, setAttendancePage: setPage,
  } = useHrmStore();

  useEffect(() => {
    fetchStats();
    fetchAttendance();
  }, [fetchStats, fetchAttendance]);

  // debounce search
  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchDraft !== (filters.search ?? "")) {
        setFilters({ search: searchDraft || undefined });
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [searchDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  if (selectedId) {
    return <AttendanceDetail employeeId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  const totalPages = meta?.totalPages ?? 1;
  const page = meta?.page ?? filters.page;

  const hasActiveFilters = Boolean(filters.department || filters.date || filters.status || filters.search);

  function clearFilters() {
    setSearchDraft("");
    setFilters({ department: undefined, date: undefined, status: undefined, search: undefined });
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      const blob = await attendanceService.downloadReport({
        date: filters.date,
        status: filters.status,
        department: filters.department,
        search: filters.search,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "attendance-report.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {isLoadingStats ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-card rounded-xl border border-border p-4 h-[110px] animate-pulse" />
          ))
        ) : !stats ? (
          <>
            <StatCardError icon="users" label="Total Employees Present" sub="(All Departments)" onRetry={() => fetchStats()} />
            <StatCardError icon="clock" label="Late Arrivals Today" sub="(All Departments)" onRetry={() => fetchStats()} />
            <StatCardError icon="calendar" label="Employees Absent" sub="(All Departments)" onRetry={() => fetchStats()} />
            <StatCardError icon="clock2" label="Average Checking Time" sub="(All Departments)" onRetry={() => fetchStats()} />
          </>
        ) : (
          <>
            <StatCard icon="users" label="Total Employees Present" sub="(All Departments)"
              value={String(stats.totalPresent)} change={stats.changes.presentChange} subtitle="from last week" />
            <StatCard icon="clock" label="Late Arrivals Today" sub="(All Departments)"
              value={String(stats.lateArrivals)} change={stats.changes.lateChange} subtitle="from last week" />
            <StatCard icon="calendar" label="Employees Absent" sub="(All Departments)"
              value={String(stats.totalAbsent)} change={stats.changes.absentChange} subtitle="from last week" />
            <StatCard icon="clock2" label="Average Checking Time" sub="(All Departments)"
              value={stats.averageCheckIn ?? "-"} change={stats.changes.checkInChange} subtitle="consistent with last week" />
          </>
        )}
      </div>

      {/* Attendance History */}
      <div className="bg-card rounded-xl border border-border flex flex-col">
        {/* Header */}
        <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-border">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-3">
            Attendance History
          </h3>

          {/* Filters row */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-wrap">
            {/* Department filter */}
            <select
              value={filters.department ?? ""}
              onChange={(e) => setFilters({ department: e.target.value || undefined })}
              className="text-[12px] font-poppins text-foreground bg-muted border border-border rounded-lg px-3 py-2 outline-none cursor-pointer h-[36px]"
            >
              {DEPARTMENTS_FILTER.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>

            {/* Date filter */}
            <input
              type="date"
              value={filters.date ?? ""}
              onChange={(e) => setFilters({ date: e.target.value || undefined })}
              className="flex items-center gap-2 h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
            />

            {/* Status filter */}
            <select
              value={filters.status ?? ""}
              onChange={(e) => setFilters({ status: (e.target.value || undefined) as AttendanceStatus | undefined })}
              className="text-[12px] font-poppins text-foreground bg-muted border border-border rounded-lg px-3 py-2 outline-none cursor-pointer h-[36px]"
            >
              <option value="">All Statuses</option>
              <option value="PRESENT">Present</option>
              <option value="LATE">Late</option>
              <option value="ABSENT">Absent</option>
            </select>

            {/* Search */}
            <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] flex-1 min-w-[160px]">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search here..."
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
              />
            </div>

            {/* Download Report */}
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors h-[36px] shrink-0 ml-auto disabled:opacity-60"
            >
              {downloading ? "Downloading..." : "Download Report"}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {["Employee Name", "Employee ID", "Employment Type", "Department", "Designation", "Clock-In", "Clock-Out", "Status"].map((h) => (
                  <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                    {h}
                  </th>
                ))}
                <th className="py-2.5 px-4" />
              </tr>
            </thead>
            <tbody>
              {isLoadingList ? (
                Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-14">
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                        <CalendarX className="w-5 h-5 text-muted-foreground" />
                      </div>
                      <p className="font-poppins text-[13px] font-semibold text-foreground">
                        No attendance records found
                      </p>
                      <p className="font-poppins text-[11px] text-muted-foreground">
                        {hasActiveFilters
                          ? "Try adjusting or clearing your filters."
                          : "Records will show up here once attendance is logged."}
                      </p>
                      {hasActiveFilters && (
                        <button
                          onClick={clearFilters}
                          className="mt-1 flex items-center gap-1 px-3 py-1.5 text-[11px] font-poppins font-semibold text-primary hover:bg-primary/10 rounded-lg transition-colors"
                        >
                          <X className="w-3 h-3" />
                          Clear filters
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                records.map((row) => {
                  const st = STATUS_STYLES[row.status] ?? STATUS_STYLES.PRESENT;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
                      onClick={() => setSelectedId(row.adminUserId)}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-muted">
                            {row.avatarUrl ? (
                              <Image src={row.avatarUrl} alt={row.name ?? ""} width={32} height={32} className="object-cover w-full h-full" />
                            ) : (
                              <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                                <span className="text-[12px] font-poppins font-bold text-primary">
                                  {(row.name ?? "?").charAt(0)}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col min-w-0">
                            <span className="font-poppins text-[12px] font-semibold text-foreground truncate">{row.name ?? "-"}</span>
                            <span className="font-poppins text-[10px] text-muted-foreground truncate">{row.email ?? "-"}</span>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.employeeCode ?? "-"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.employmentType ?? "-"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.department ?? "-"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.designation ?? "-"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.clockIn ?? "-"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.clockOut ?? "-"}</td>
                      <td className="py-3 px-4">
                        <span
                          className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap"
                          style={{ backgroundColor: st.bg, color: st.text }}
                        >
                          {st.label}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <button className="text-muted-foreground hover:text-foreground transition-colors" onClick={(e) => e.stopPropagation()}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-1 px-4 sm:px-5 py-4 flex-wrap">
            <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-4 h-4 text-foreground" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button key={p} onClick={() => setPage(p)}
                className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                  page === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
                }`}>
                {p}
              </button>
            ))}
            <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronRight className="w-4 h-4 text-foreground" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}