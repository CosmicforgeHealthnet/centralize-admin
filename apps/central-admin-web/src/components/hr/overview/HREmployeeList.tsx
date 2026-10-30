"use client";

import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useHrmStore } from "@/stores/hrm.store";

// ─── Mock Data for Performance (until endpoint exists) ──────────────────────

const PERFORMANCE_STYLES: Record<string, { bg: string; text: string }> = {
  Excellent: { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
  Good: { bg: "rgba(39,46,167,0.10)", text: "#272EA7" },
  Average: { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  Poor: { bg: "rgba(246,69,69,0.12)", text: "#F64545" },
};

const MOCK_PERFORMANCE = ["Excellent", "Good", "Average", "Poor"];
const PERIOD_OPTIONS = ["Last Month", "Last Quarter", "This Year"];

// ─── Skeleton Row ─────────────────────────────────────────────────────────────

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

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function HREmployeeList() {
  const [period, setPeriod] = useState("Last Month");
  const [page, setPage] = useState(1);

  const {
    employees,
    meta,
    isLoadingList,
    fetchEmployees,
  } = useHrmStore();

  useEffect(() => {
    fetchEmployees({ page, limit: 8 });
  }, [page]);

  const perPage = 8;
  const totalPages = meta?.totalPages || 1;
  const currentPage = meta?.page || 1;

  const handlePageChange = (newPage: number) => {
    setPage(newPage);

  };

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-3">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">
          Employee List
        </h3>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="text-[11px] font-poppins text-muted-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer"
        >
          {PERIOD_OPTIONS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px]">
          <thead>
            <tr className="border-b border-border">
              {["Employee Name", "Employee ID", "Employment Type", "Department", "Designation", "Performance", "Action"].map((h) => (
                <th
                  key={h}
                  className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoadingList ? (
              Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
            ) : employees.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-foreground">
                  No employees found
                </td>
              </tr>
            ) : (
              employees.map((emp, index) => {
                const performance = MOCK_PERFORMANCE[index % MOCK_PERFORMANCE.length];
                const perf = PERFORMANCE_STYLES[performance] ?? PERFORMANCE_STYLES["Good"];
                return (
                  <tr
                    key={emp.id}
                    className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                  >
                    {/* Name + Avatar */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-muted">
                          {emp.avatarUrl ? (
                            <Image
                              src={emp.avatarUrl}
                              alt={emp.name}
                              width={32}
                              height={32}
                              className="object-cover w-full h-full"
                            />
                          ) : (
                            <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                              <span className="text-[12px] font-poppins font-bold text-primary">
                                {emp.name.charAt(0)}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-poppins text-[12px] font-semibold text-foreground truncate">
                            {emp.name}
                          </span>
                          <span className="font-poppins text-[10px] text-muted-foreground truncate">
                            {emp.email}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Employee ID */}
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                      {emp.employeeCode || "#" + emp.id.slice(0, 8)}
                    </td>

                    {/* Employment Type */}
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                      {emp.employmentType || "—"}
                    </td>

                    {/* Department */}
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                      {emp.department || "—"}
                    </td>

                    {/* Designation */}
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                      {emp.designation || emp.position || "—"}
                    </td>

                    {/* Performance Badge (Mock) */}
                    <td className="py-3 px-4">
                      <span
                        className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap"
                        style={{ backgroundColor: perf.bg, color: perf.text }}
                      >
                        {performance}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2.5">
                        <button
                          title="Edit"
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                        <button
                          title="Delete"
                          className="text-muted-foreground hover:text-red-500 transition-colors"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                            <path d="M10 11v6M14 11v6"/>
                            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                          </svg>
                        </button>
                      </div>
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
          <button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage <= 1}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-foreground" />
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => handlePageChange(p)}
              className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                currentPage === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
              }`}
            >
              {p}
            </button>
          ))}

          <button
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-foreground" />
          </button>
        </div>
      )}
    </div>
  );
}