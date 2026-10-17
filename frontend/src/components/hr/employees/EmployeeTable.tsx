"use client";

import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { EmployeeListItem } from "@/types/hrm.types";

// ─── Skeleton Row ─────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="border-b border-border/50">
      {Array.from({ length: 6 }).map((_, i) => (
        <td key={i} className="py-3 px-4">
          <div className="h-4 bg-muted rounded animate-pulse w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function EmployeeTable({
  employees,
  isLoading,
  onSelect,
}: {
  employees: EmployeeListItem[];
  isLoading: boolean;
  onSelect: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const perPage    = 10;
  const totalPages = Math.max(1, Math.ceil(employees.length / perPage));
  const paged      = employees.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {["Employee Name", "Employee ID", "Employment Type", "Department", "Designation", "Action"].map((h) => (
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
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-10 text-center font-poppins text-[12px] text-muted-foreground">
                  No employees found.
                </td>
              </tr>
            ) : (
              paged.map((emp) => (
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

                  <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                    {emp.employeeCode || "—"}
                  </td>

                  <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                    {emp.employmentType || "—"}
                  </td>

                  <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                    {emp.department || "—"}
                  </td>

                  <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                    {emp.designation || "—"}
                  </td>

                  {/* Actions */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2.5">
                      <button
                        onClick={() => onSelect(emp.id)}
                        title="View"
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-1 px-4 sm:px-5 py-4 flex-wrap">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-foreground" />
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                page === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
              }`}
            >
              {p}
            </button>
          ))}
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-foreground" />
          </button>
        </div>
      )}
    </div>
  );
}