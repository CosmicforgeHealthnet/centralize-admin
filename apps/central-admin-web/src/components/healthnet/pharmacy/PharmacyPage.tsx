"use client";

import { useState, useEffect, useMemo } from "react";
import Image from "next/image";
import { Search, Pencil, Trash2 } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

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
        <span className="text-[11px] font-poppins font-bold text-primary">{name.charAt(0)}</span>
      )}
    </div>
  );
}

function TableRowSkeleton() {
  return (
    <tr className="border-b border-border">
      <td className="px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-muted animate-pulse shrink-0" />
          <div className="h-3.5 w-28 bg-muted rounded animate-pulse" />
        </div>
       </td>
      <td className="px-5 py-3"><div className="h-3 w-24 bg-muted rounded animate-pulse" /></td>
      <td className="px-5 py-3"><div className="h-3 w-36 bg-muted rounded animate-pulse" /></td>
      <td className="px-5 py-3"><div className="h-3 w-24 bg-muted rounded animate-pulse" /></td>
      <td className="px-5 py-3"><div className="h-3 w-20 bg-muted rounded animate-pulse" /></td>
      <td className="px-5 py-3"><div className="h-3 w-12 bg-muted rounded animate-pulse" /></td>
    </tr>
  );
}

function MobileCardSkeleton() {
  return (
    <div className="py-3 border-b border-border">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-full bg-muted animate-pulse shrink-0" />
        <div className="flex flex-col gap-1.5 flex-1">
          <div className="h-3.5 w-32 bg-muted rounded animate-pulse" />
          <div className="h-3 w-40 bg-muted rounded animate-pulse" />
        </div>
      </div>
      <div className="mt-2 flex gap-4 pl-[44px]">
        <div className="h-3 w-20 bg-muted rounded animate-pulse" />
        <div className="h-3 w-20 bg-muted rounded animate-pulse" />
        <div className="h-3 w-16 bg-muted rounded animate-pulse" />
      </div>
    </div>
  );
}

export default function PharmacyPage({ onViewPharmacy }: { onViewPharmacy: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const { pharmacies, pharmaciesLoading, pharmaciesError, fetchPharmacies } = useHealthnetStore();

  useEffect(() => {
    fetchPharmacies({ page, limit: PAGE_SIZE, search: search.trim() || undefined });
  }, [page]);

  const handleSearch = () => {
    setPage(1);
    fetchPharmacies({ page: 1, limit: PAGE_SIZE, search: search.trim() || undefined });
  };

  const rows = pharmacies?.pharmacies ?? [];
  const total = pharmacies?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const pageNums: (number | "…")[] = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, "…", totalPages];
    if (page >= totalPages - 3) return [1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, "…", page - 1, page, page + 1, "…", totalPages];
  }, [page, totalPages]);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[20px] font-poppins font-bold text-foreground">Pharmacy</h1>
      
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <p className="text-[15px] font-poppins font-bold text-foreground mb-4">All Pharmacy</p>
          <div className="flex gap-3">
            <div className="flex-1 flex items-center gap-2.5 bg-muted rounded-[10px] px-3.5 py-2.5 border border-transparent focus-within:border-primary/30 transition-colors">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <input 
                type="text" 
                placeholder="Search here..." 
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="flex-1 bg-transparent text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none" 
              />
            </div>
            <button 
              onClick={handleSearch} 
              className="px-5 py-2.5 bg-primary text-primary-foreground text-[13px] font-poppins font-semibold rounded-[10px] hover:bg-primary/90 active:scale-95 transition-all duration-150 shrink-0"
            >
              Search
            </button>
          </div>
        </div>

        {!pharmaciesLoading && pharmaciesError && (
          <div className="py-16 text-center">
            <p className="text-[13px] font-poppins text-destructive">{pharmaciesError}</p>
          </div>
        )}

        {/* Table — desktop */}
        {!pharmaciesError && (
          <div className="hidden sm:block overflow-x-auto">
            <table className="min-w-[860px] w-full">
              <thead>
                <tr className="border-b border-border">
                  {["Pharmacy Name", "Location", "Email", "Phone Number", "Joining Date", "Action"].map((h) => (
                    <th key={h} className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pharmaciesLoading
                  ? Array.from({ length: PAGE_SIZE }).map((_, i) => <TableRowSkeleton key={i} />)
                  : rows.map((p) => (
                      <tr key={p.id} className="border-b border-border hover:bg-muted/50 transition-colors">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={p.name ?? "P"} src={p.avatarUrl} />
                            <span className="text-[13px] font-poppins font-medium text-foreground whitespace-nowrap">{p.name ?? "—"}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{p.location ?? "—"}</span>
                        </td>
                        <td className="px-5 py-3">
                          <span className="text-[12px] font-poppins text-muted-foreground block truncate max-w-[180px]">{p.email ?? "—"}</span>
                        </td>
                        <td className="px-5 py-3">
                          <span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{p.phone ?? "—"}</span>
                        </td>
                        <td className="px-5 py-3">
                          <span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{p.joiningDate ?? "—"}</span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <button 
                              onClick={() => onViewPharmacy(p.id)} 
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
                    ))}
                {!pharmaciesLoading && rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-16 text-center">
                      <p className="text-[13px] font-poppins text-muted-foreground">No pharmacies found.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Cards — mobile */}
        {!pharmaciesError && (
          <div className="sm:hidden px-4 pb-2">
            {pharmaciesLoading
              ? Array.from({ length: 6 }).map((_, i) => <MobileCardSkeleton key={i} />)
              : rows.map((p) => (
                  <div key={p.id} className="py-3 border-b border-border last:border-0">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={p.name ?? "P"} src={p.avatarUrl} />
                        <div>
                          <p className="text-[13px] font-poppins font-semibold text-foreground">{p.name ?? "—"}</p>
                          <p className="text-[11px] font-poppins text-muted-foreground truncate max-w-[180px]">{p.email ?? "—"}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <button 
                          onClick={() => onViewPharmacy(p.id)} 
                          className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-primary/10 transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5 text-primary" />
                        </button>
                        <button className="w-7 h-7 flex items-center justify-center rounded-[6px] hover:bg-destructive/10 transition-colors">
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-[44px]">
                      <span className="text-[11px] font-poppins text-muted-foreground">{p.location ?? "—"}</span>
                      <span className="text-[11px] font-poppins text-muted-foreground">{p.phone ?? "—"}</span>
                      <span className="text-[11px] font-poppins text-muted-foreground">{p.joiningDate ?? "—"}</span>
                    </div>
                  </div>
                ))}
            {!pharmaciesLoading && rows.length === 0 && (
              <p className="py-10 text-center text-[13px] font-poppins text-muted-foreground">No pharmacies found.</p>
            )}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-1.5 px-5 py-4 border-t border-border">
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