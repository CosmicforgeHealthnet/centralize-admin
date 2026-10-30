"use client";

import { useState, useMemo, useEffect } from "react";
import Image from "next/image";
import { Search, Pencil, Trash2 } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

type TabType = "all" | "individual" | "family";
const TABS: { label: string; value: TabType }[] = [
  { label: "All Patients", value: "all" },
  { label: "Individual",   value: "individual" },
  { label: "Family",       value: "family" },
];

const PAGE_SIZE = 13;

function Avatar({ name, src }: { name: string; src?: string | null }) {
  return (
    <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden shrink-0 flex items-center justify-center">
      {src ? (
        <Image src={src} alt={name} width={32} height={32} className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
      ) : (
        <span className="text-[11px] font-poppins font-bold text-primary">{name.charAt(0)}</span>
      )}
    </div>
  );
}

export default function PatientsPage({ onViewPatient }: { onViewPatient: (id: string) => void }) {
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [search, setSearch]       = useState("");
  const [page, setPage]           = useState(1);

  const { patients, patientsLoading, fetchPatients } = useHealthnetStore();

  useEffect(() => {
    fetchPatients({ limit: 100 });
  }, [fetchPatients]);

  const filtered = useMemo(() => {
    const rows = patients?.patients ?? [];
    let data = rows;
    if (activeTab === "individual") data = data.filter((p) => p.profileType?.toLowerCase() === "individual");
    if (activeTab === "family")     data = data.filter((p) => p.profileType?.toLowerCase() === "family");
    if (search.trim()) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.email.toLowerCase().includes(q) ||
          (p.phone ?? "").includes(q),
      );
    }
    return data;
  }, [patients, activeTab, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleTabChange = (t: TabType) => { setActiveTab(t); setPage(1); };

  const pageNums: (number | "…")[] = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, "…", totalPages];
    if (page >= totalPages - 3) return [1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, "…", page - 1, page, page + 1, "…", totalPages];
  }, [page, totalPages]);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[20px] font-poppins font-bold text-foreground">Patients</h1>

      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] overflow-hidden dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)]">
        {/* Search */}
        <div className="p-4 sm:p-5 border-b border-border">
          <div className="flex gap-3">
            <div className="flex-1 flex items-center gap-2.5 bg-muted rounded-[10px] px-3.5 py-2.5 border border-transparent focus-within:border-primary/30 transition-colors">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <input type="text" placeholder="Type here..." value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="flex-1 bg-transparent text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none" />
            </div>
            <button onClick={() => setPage(1)}
              className="px-5 py-2.5 bg-primary text-primary-foreground text-[13px] font-poppins font-semibold rounded-[10px] hover:bg-primary/90 active:scale-95 transition-all duration-150 shrink-0">
              Search
            </button>
          </div>
        </div>

        {/* Tabs */}
    {/* Tabs */}
<div className="flex border-b border-border overflow-x-auto px-4 sm:px-5">
  {TABS.map((tab) => (
    <button key={tab.value} onClick={() => handleTabChange(tab.value)}
      className={`relative px-4 py-3.5 text-[13px] font-poppins font-medium whitespace-nowrap transition-colors shrink-0 ${
        activeTab === tab.value 
          ? "text-primary dark:text-white" 
          : "text-muted-foreground hover:text-foreground"
      }`}>
      {tab.label}
      {activeTab === tab.value && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary dark:bg-white rounded-t-full" />}
    </button>
  ))}
</div>

        <div className="px-4 sm:px-5 pt-4 pb-1">
          <p className="text-[13px] font-poppins font-semibold text-foreground">
            {TABS.find((t) => t.value === activeTab)?.label}
          </p>
        </div>

        {/* Table — desktop */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="min-w-[900px] w-full">
            <thead>
              <tr className="border-b border-border">
                {["Patient Name","Profile Type","Email","Phone Number","Joining Date","Action"].map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">{h}</th>
                ))}
               </tr>
            </thead>
            <tbody>
              {patientsLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border animate-pulse">
                    {Array.from({ length: 6 }).map((__, j) => (
                      <td key={j} className="px-5 py-3"><div className="h-3 bg-muted rounded w-24" /></td>
                    ))}
                  </tr>
                ))
              ) : paginated.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-16 text-center">
                  <p className="text-[13px] font-poppins text-muted-foreground">No patients found.</p>
                </td></tr>
              ) : (
                paginated.map((patient) => (
                  <tr key={patient.id} className="border-b border-border hover:bg-muted/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={patient.name} src={patient.avatarUrl} />
                        <span className="text-[13px] font-poppins font-medium text-foreground">{patient.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3"><span className="text-[12px] font-poppins text-foreground/70">{patient.profileType ?? "—"}</span></td>
                    <td className="px-5 py-3"><span className="text-[12px] font-poppins text-muted-foreground block truncate max-w-[180px]">{patient.email}</span></td>
                    <td className="px-5 py-3"><span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{patient.phone ?? "—"}</span></td>
                    <td className="px-5 py-3"><span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{patient.joiningDate ?? "—"}</span></td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <button onClick={() => onViewPatient(patient.id)}
                          className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-primary/10 transition-colors" title="View">
                          <Pencil className="w-3.5 h-3.5 text-primary" />
                        </button>
                        <button className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-destructive/10 transition-colors" title="Delete">
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
          {patientsLoading ? (
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
            <p className="py-10 text-center text-[13px] font-poppins text-muted-foreground">No patients found.</p>
          ) : (
            paginated.map((patient) => (
              <div key={patient.id} className="py-3 border-b border-border last:border-0">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={patient.name} src={patient.avatarUrl} />
                    <div>
                      <p className="text-[13px] font-poppins font-semibold text-foreground">{patient.name}</p>
                      <p className="text-[11px] font-poppins text-muted-foreground truncate max-w-[180px]">{patient.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <button onClick={() => onViewPatient(patient.id)} className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-primary/10 transition-colors">
                      <Pencil className="w-3.5 h-3.5 text-primary" />
                    </button>
                    <button className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-destructive/10 transition-colors">
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-[44px]">
                  <span className="text-[11px] font-poppins font-medium text-foreground/70">{patient.profileType ?? "—"}</span>
                  <span className="text-[11px] font-poppins text-muted-foreground">{patient.phone ?? "—"}</span>
                  <span className="text-[11px] font-poppins text-muted-foreground">{patient.joiningDate ?? "—"}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-1.5 px-5 py-4 border-t border-border">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
              className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground">‹</button>
            {pageNums.map((n, idx) =>
              n === "…" ? (
                <span key={`e-${idx}`} className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-muted-foreground">…</span>
              ) : (
                <button key={n} onClick={() => setPage(n as number)}
                  className={`w-7 h-7 flex items-center justify-center rounded-[6px] text-[12px] font-poppins font-medium transition-colors ${
                    page === n ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:border-primary hover:text-primary"
                  }`}>{n}</button>
              )
            )}
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground">›</button>
          </div>
        )}
      </div>
    </div>
  );
}