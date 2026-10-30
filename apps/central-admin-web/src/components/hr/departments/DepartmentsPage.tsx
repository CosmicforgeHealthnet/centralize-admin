"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";
import { DepartmentEmployee } from "@/types/hrm.types";

// ─── View Toggle Icons ────────────────────────────────────────────────────────

function GridIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="1"  y="1"  width="6" height="6" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="11" y="1"  width="6" height="6" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="1"  y="11" width="6" height="6" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="11" y="11" width="6" height="6" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
    </svg>
  );
}

function ListIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="1" y="2"    width="16" height="2.5" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="1" y="7.5"  width="16" height="2.5" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
      <rect x="1" y="13"   width="16" height="2.5" rx="1" fill={active ? "#272EA7" : "currentColor"} fillOpacity={active ? 1 : 0.4} />
    </svg>
  );
}

// ─── Department Tab ───────────────────────────────────────────────────────────

function DeptTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-start px-5 py-3 rounded-xl border transition-all duration-150 shrink-0 min-w-[110px] ${
        active
          ? "bg-primary/8 border-primary/30 text-primary"
          : "bg-card border-border text-muted-foreground hover:border-primary/20 hover:text-foreground"
      }`}
    >
      <span className={`font-poppins text-[12px] font-semibold whitespace-nowrap ${active ? "text-primary" : "text-foreground"}`}>
        {label}
      </span>
      <span className={`font-poppins text-[22px] font-bold leading-tight mt-0.5 ${active ? "text-primary" : "text-foreground"}`}>
        {count}
      </span>
    </button>
  );
}

// ─── Skeleton Dept Tab ─────────────────────────────────────────────────────────

function SkeletonDeptTab() {
  return (
    <div className="flex flex-col gap-1.5 px-5 py-3 rounded-xl border border-border bg-card shrink-0 min-w-[110px] animate-pulse">
      <div className="h-3 w-16 bg-muted rounded" />
      <div className="h-5 w-8 bg-muted rounded" />
    </div>
  );
}

// ─── Staff Grid Card ──────────────────────────────────────────────────────────

function StaffCard({ emp }: { emp: DepartmentEmployee }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex flex-col items-center gap-2 hover:shadow-md hover:border-primary/30 transition-all duration-200 text-center">
      <div className="w-16 h-16 rounded-full overflow-hidden bg-muted shrink-0">
        {emp.avatarUrl ? (
          <Image src={emp.avatarUrl} alt={emp.name} width={64} height={64} className="object-cover w-full h-full" />
        ) : (
          <div className="w-full h-full bg-primary/10 flex items-center justify-center">
            <span className="text-[20px] font-poppins font-bold text-primary">{emp.name.charAt(0)}</span>
          </div>
        )}
      </div>
      <div className="flex flex-col items-center min-w-0 w-full">
        <span className="font-poppins text-[13px] font-semibold text-foreground truncate w-full">{emp.name}</span>
        <span className="font-poppins text-[11px] font-semibold text-primary truncate w-full">{emp.designation || "—"}</span>
        <span className="font-poppins text-[11px] text-muted-foreground truncate w-full">{emp.department || "—"}</span>
      </div>
    </div>
  );
}

function SkeletonStaffCard() {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex flex-col items-center gap-2 animate-pulse">
      <div className="w-16 h-16 rounded-full bg-muted" />
      <div className="h-3 w-20 bg-muted rounded" />
      <div className="h-3 w-16 bg-muted rounded" />
    </div>
  );
}

// ─── Staff Table ──────────────────────────────────────────────────────────────

function StaffTable({
  data,
  isLoading,
  page,
  totalPages,
  onPageChange,
}: {
  data: DepartmentEmployee[];
  isLoading: boolean;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {["Employee Name", "Employee ID", "Employment Type", "Department", "Designation", "Action"].map((h) => (
                <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-border/50">
                  {Array.from({ length: 6 }).map((_, j) => (
                    <td key={j} className="py-3 px-4">
                      <div className="h-4 bg-muted rounded animate-pulse w-full max-w-[120px]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-10 text-center font-poppins text-[12px] text-muted-foreground">
                  No staff found in this department.
                </td>
              </tr>
            ) : (
              data.map((emp) => (
                <tr key={emp.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-muted">
                        {emp.avatarUrl ? (
                          <Image src={emp.avatarUrl} alt={emp.name} width={32} height={32} className="object-cover w-full h-full" />
                        ) : (
                          <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                            <span className="text-[12px] font-poppins font-bold text-primary">{emp.name.charAt(0)}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="font-poppins text-[12px] font-semibold text-foreground truncate">{emp.name}</span>
                        <span className="font-poppins text-[10px] text-muted-foreground truncate">{emp.email}</span>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{emp.employeeCode || "—"}</td>
                  <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{emp.employmentType || "—"}</td>
                  <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{emp.department || "—"}</td>
                  <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{emp.designation || "—"}</td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2.5">
                      <button title="Edit" className="text-muted-foreground hover:text-primary transition-colors">
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
        <div className="flex items-center justify-end gap-1 px-4 py-4 flex-wrap">
          <button onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page === 1}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            <ChevronLeft className="w-4 h-4 text-foreground" />
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button key={p} onClick={() => onPageChange(p)}
              className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                page === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
              }`}>
              {p}
            </button>
          ))}
          <button onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page === totalPages}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            <ChevronRight className="w-4 h-4 text-foreground" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function DepartmentsPage() {
  const [activeDept, setActiveDept] = useState("all");
  const [view,       setView]       = useState<"grid" | "table">("grid");
  const [page,       setPage]       = useState(1);

  const {
    departments,
    departmentEmployees,
    departmentMeta,
    isLoadingDepartments,
    isLoadingDepartmentEmployees,
    departmentsError,
    fetchDepartments,
    fetchDepartmentEmployees,
  } = useHrmStore();

  useEffect(() => {
    fetchDepartments();
  }, [fetchDepartments]);

  useEffect(() => {
    fetchDepartmentEmployees(activeDept, { page, limit: 15 });
  }, [activeDept, page, fetchDepartmentEmployees]);

  const handleDeptChange = (id: string) => {
    setActiveDept(id);
    setPage(1);
  };

  const totalPages = departmentMeta?.totalPages ?? 1;

  return (
    <div className="flex flex-col gap-4">
      {/* Department Tabs */}
      <div className="overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        <div className="flex gap-2 min-w-max">
          {isLoadingDepartments ? (
            Array.from({ length: 5 }).map((_, i) => <SkeletonDeptTab key={i} />)
          ) : (
            departments.map((dept) => (
              <DeptTab
                key={dept.id}
                label={dept.label}
                count={dept.count}
                active={activeDept === dept.id}
                onClick={() => handleDeptChange(dept.id)}
              />
            ))
          )}
        </div>
      </div>

      {departmentsError && (
        <p className="font-poppins text-[12px] text-red-500">{departmentsError}</p>
      )}

      {/* Staff Section */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-border">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">
            All Department Staffs
          </h3>
          <div className="flex items-center gap-1 bg-muted border border-border rounded-lg p-1">
            <button
              onClick={() => setView("table")}
              className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                view === "table" ? "bg-card shadow-sm" : "hover:bg-card/60"
              }`}
              title="Table view"
            >
              <ListIcon active={view === "table"} />
            </button>
            <button
              onClick={() => setView("grid")}
              className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                view === "grid" ? "bg-card shadow-sm" : "hover:bg-card/60"
              }`}
              title="Grid view"
            >
              <GridIcon active={view === "grid"} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4">
          {view === "grid" ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {isLoadingDepartmentEmployees ? (
                  Array.from({ length: 10 }).map((_, i) => <SkeletonStaffCard key={i} />)
                ) : departmentEmployees.length === 0 ? (
                  <p className="font-poppins text-[12px] text-muted-foreground col-span-full text-center py-8">
                    No staff found in this department.
                  </p>
                ) : (
                  departmentEmployees.map((emp) => <StaffCard key={emp.id} emp={emp} />)
                )}
              </div>
              {/* Grid pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-end gap-1 pt-4 flex-wrap">
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
            </>
          ) : (
            <StaffTable
              data={departmentEmployees}
              isLoading={isLoadingDepartmentEmployees}
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          )}
        </div>
      </div>
    </div>
  );
}