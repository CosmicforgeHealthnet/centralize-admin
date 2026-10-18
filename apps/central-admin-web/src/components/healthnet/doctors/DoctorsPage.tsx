"use client";

import { useState, useMemo, useEffect } from "react";
import Image from "next/image";
import { Search, Pencil, Trash2, ChevronDown } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

const DEPARTMENTS = [
  "All Departments",
  "General Medicine",
  "Obstetrics & Gynecology",
  "Pediatrics",
  "Cardiology",
  "Neurology",
  "Orthopedics",
];

const PAGE_SIZE = 13;

function Avatar({ name, src }: { name: string; src?: string | null }) {
  return (
    <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden shrink-0 flex items-center justify-center">
      {src ? (
        <Image 
          src={src} 
          alt={name} 
          width={32} 
          height={32} 
          className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} 
        />
      ) : (
        <span className="text-[11px] font-poppins font-bold text-primary">
          {name.replace("Dr ", "").charAt(0)}
        </span>
      )}
    </div>
  );
}

export default function DoctorsPage({ onViewDoctor }: { onViewDoctor: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("All Departments");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [page, setPage] = useState(1);

  const { doctors, doctorsLoading, fetchDoctors } = useHealthnetStore();

  useEffect(() => {
    fetchDoctors({ limit: 100 });
  }, [fetchDoctors]);

  const filtered = useMemo(() => {
    const rows = doctors?.doctors ?? [];
    let data = rows;
    if (department !== "All Departments") {
      data = data.filter((d) => d.department === department);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      data = data.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.email.toLowerCase().includes(q) ||
          (d.department ?? "").toLowerCase().includes(q) ||
          (d.phone ?? "").includes(q)
      );
    }
    return data;
  }, [doctors, department, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleDepartmentSelect = (dept: string) => {
    setDepartment(dept);
    setDropdownOpen(false);
    setPage(1);
  };

  const pageNums: (number | "…")[] = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, "…", totalPages];
    if (page >= totalPages - 3) return [1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, "…", page - 1, page, page + 1, "…", totalPages];
  }, [page, totalPages]);

  return (
    <div className="flex flex-col gap-5">
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-[20px] font-poppins font-bold text-foreground">Doctors</h1>

        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 px-3.5 py-2 bg-card border border-border rounded-[10px] text-[13px] font-poppins text-foreground hover:border-primary/40 transition-colors shadow-[0_1px_4px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_4px_0_rgba(0,0,0,0.2)]"
          >
            <span className="max-w-[140px] truncate">
              {department === "All Departments" ? "General Medicine" : department}
            </span>
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform duration-150 ${dropdownOpen ? "rotate-180" : ""}`} />
          </button>
          
          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setDropdownOpen(false)} />
              <div className="absolute right-0 top-full mt-1.5 z-20 bg-card border border-border rounded-[10px] shadow-[0_4px_20px_0_rgba(0,0,0,0.10)] dark:shadow-[0_4px_20px_0_rgba(0,0,0,0.3)] overflow-hidden min-w-[200px]">
                {DEPARTMENTS.map((dept) => (
                  <button
                    key={dept}
                    onClick={() => handleDepartmentSelect(dept)}
                    className={`w-full text-left px-4 py-2.5 text-[13px] font-poppins transition-colors ${
                      department === dept
                        ? "bg-primary/8 text-primary font-semibold"
                        : "text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {dept}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
        {/* Search bar */}
        <div className="p-4 sm:p-5 border-b border-border">
          <div className="flex gap-3">
            <div className="flex-1 flex items-center gap-2.5 bg-muted rounded-[10px] px-3.5 py-2.5 border border-transparent focus-within:border-primary/30 transition-colors">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Type here..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="flex-1 bg-transparent text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>
            <button
              onClick={() => setPage(1)}
              className="px-5 py-2.5 bg-primary text-primary-foreground text-[13px] font-poppins font-semibold rounded-[10px] hover:bg-primary/90 active:scale-95 transition-all duration-150 shrink-0"
            >
              Search
            </button>
          </div>
        </div>

        {/* Tab */}
        <div className="flex border-b border-border px-4 sm:px-5">
          <div className="relative px-4 py-3.5">
            <span className="text-[13px] font-poppins font-medium text-primary dark:text-white">All Doctors</span>
            <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary dark:bg-white rounded-t-full" />
          </div>
        </div>

        <div className="px-4 sm:px-5 pt-4 pb-1">
          <p className="text-[13px] font-poppins font-semibold text-foreground">All Doctors</p>
        </div>

        {/* Table — desktop */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="min-w-[1000px] w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">Doctors Name</th>
                <th className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">Department</th>
                <th className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">Experience</th>
                <th className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">Email</th>
                <th className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">Phone Number</th>
                <th className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">Joining Date</th>
                <th className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">Action</th>
              </tr>
            </thead>
            <tbody>
              {doctorsLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border animate-pulse">
                    <td className="px-5 py-3"><div className="h-3 bg-muted rounded w-24" /></td>
                    <td className="px-5 py-3"><div className="h-3 bg-muted rounded w-24" /></td>
                    <td className="px-5 py-3"><div className="h-3 bg-muted rounded w-24" /></td>
                    <td className="px-5 py-3"><div className="h-3 bg-muted rounded w-24" /></td>
                    <td className="px-5 py-3"><div className="h-3 bg-muted rounded w-24" /></td>
                    <td className="px-5 py-3"><div className="h-3 bg-muted rounded w-24" /></td>
                    <td className="px-5 py-3"><div className="h-3 bg-muted rounded w-24" /></td>
                  </tr>
                ))
              ) : paginated.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-16 text-center">
                    <p className="text-[13px] font-poppins text-muted-foreground">No doctors found.</p>
                  </td>
                </tr>
              ) : (
                paginated.map((doctor) => (
                  <tr key={doctor.id} className="border-b border-border hover:bg-muted/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={doctor.name} src={doctor.avatarUrl} />
                        <span className="text-[13px] font-poppins font-medium text-foreground">{doctor.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-[12px] font-poppins text-foreground/70 whitespace-nowrap">{doctor.department ?? "—"}</span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{doctor.experience ? `${doctor.experience} yrs` : "—"}</span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-[12px] font-poppins text-muted-foreground block truncate max-w-[180px]">{doctor.email}</span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{doctor.phone ?? "—"}</span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{doctor.joiningDate ?? "—"}</span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <button
                          onClick={() => onViewDoctor(doctor.id)}
                          className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-primary/10 transition-colors"
                          title="View"
                        >
                          <Pencil className="w-3.5 h-3.5 text-primary" />
                        </button>
                        <button
                          className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-destructive/10 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Cards — mobile */}
        <div className="sm:hidden px-4 pb-2">
          {doctorsLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="py-3 border-b border-border animate-pulse">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-muted shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 bg-muted rounded w-32" />
                    <div className="h-2.5 bg-muted rounded w-48" />
                  </div>
                </div>
              </div>
            ))
          ) : paginated.length === 0 ? (
            <p className="py-10 text-center text-[13px] font-poppins text-muted-foreground">No doctors found.</p>
          ) : (
            paginated.map((doctor) => (
              <div key={doctor.id} className="py-3 border-b border-border last:border-0">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={doctor.name} src={doctor.avatarUrl} />
                    <div>
                      <p className="text-[13px] font-poppins font-semibold text-foreground">{doctor.name}</p>
                      <p className="text-[11px] font-poppins text-muted-foreground truncate max-w-[180px]">{doctor.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <button onClick={() => onViewDoctor(doctor.id)} className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-primary/10 transition-colors">
                      <Pencil className="w-3.5 h-3.5 text-primary" />
                    </button>
                    <button className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-destructive/10 transition-colors">
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-[44px]">
                  <span className="text-[11px] font-poppins font-medium text-foreground/70">{doctor.department ?? "—"}</span>
                  <span className="text-[11px] font-poppins text-muted-foreground">{doctor.phone ?? "—"}</span>
                  <span className="text-[11px] font-poppins text-muted-foreground">{doctor.joiningDate ?? "—"}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-1.5 px-5 py-4 border-t border-border">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
            >
              ‹
            </button>
            {pageNums.map((n, idx) =>
              n === "…" ? (
                <span key={`e-${idx}`} className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-muted-foreground">…</span>
              ) : (
                <button
                  key={n}
                  onClick={() => setPage(n as number)}
                  className={`w-7 h-7 flex items-center justify-center rounded-[6px] text-[12px] font-poppins font-medium transition-colors ${
                    page === n
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground hover:border-primary hover:text-primary"
                  }`}
                >
                  {n}
                </button>
              )
            )}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}