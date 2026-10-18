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

export default function VendorsPage({ onViewVendor }: { onViewVendor: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const { vendors, vendorsLoading, vendorsError, fetchVendors } = useHealthnetStore();

  useEffect(() => {
    fetchVendors({ page, limit: PAGE_SIZE, search: search.trim() || undefined });
  }, [page]);

  const handleSearch = () => {
    setPage(1);
    fetchVendors({ page: 1, limit: PAGE_SIZE, search: search.trim() || undefined });
  };

  const rows = vendors?.vendors ?? [];
  const total = vendors?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const pageNums: (number | "…")[] = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, "…", totalPages];
    if (page >= totalPages - 3) return [1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, "…", page - 1, page, page + 1, "…", totalPages];
  }, [page, totalPages]);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[20px] font-poppins font-bold text-foreground">Vendors</h1>

      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-border">
          <p className="text-[15px] font-poppins font-semibold text-foreground mb-4">All Vendors</p>
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

        {!vendorsLoading && vendorsError && (
          <div className="py-16 text-center">
            <p className="text-[13px] font-poppins text-destructive">{vendorsError}</p>
          </div>
        )}

        {/* Table — desktop */}
        {!vendorsError && (
          <div className="hidden sm:block overflow-x-auto">
            <table className="min-w-[800px] w-full">
              <thead>
                <tr className="border-b border-border">
                  {["Vendor Business Name", "Location", "Email", "Phone Number", "Joining Date", "Action"].map((h) => (
                    <th key={h} className="px-5 py-3 text-left text-[11px] font-poppins font-semibold text-muted-foreground tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vendorsLoading
                  ? Array.from({ length: PAGE_SIZE }).map((_, i) => <TableRowSkeleton key={i} />)
                  : rows.map((v) => (
                      <tr key={v.id} className="border-b border-border hover:bg-muted/50 transition-colors">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={v.businessName ?? "V"} src={v.avatarUrl} />
                            <span className="text-[13px] font-poppins font-medium text-foreground whitespace-nowrap">{v.businessName ?? "—"}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{v.location ?? "—"}</span>
                        </td>
                        <td className="px-5 py-3">
                          <span className="text-[12px] font-poppins text-muted-foreground block truncate max-w-[200px]">{v.email ?? "—"}</span>
                        </td>
                        <td className="px-5 py-3">
                          <span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{v.phone ?? "—"}</span>
                        </td>
                        <td className="px-5 py-3">
                          <span className="text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{v.joiningDate ?? "—"}</span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <button
                              onClick={() => onViewVendor(v.id)}
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
                {!vendorsLoading && rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-16 text-center">
                      <p className="text-[13px] font-poppins text-muted-foreground">No vendors found.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Cards — mobile */}
        {!vendorsError && (
          <div className="sm:hidden px-4 pb-2">
            {vendorsLoading
              ? Array.from({ length: 6 }).map((_, i) => <MobileCardSkeleton key={i} />)
              : rows.map((v) => (
                  <div key={v.id} className="py-3 border-b border-border last:border-0">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={v.businessName ?? "V"} src={v.avatarUrl} />
                        <div>
                          <p className="text-[13px] font-poppins font-semibold text-foreground">{v.businessName ?? "—"}</p>
                          <p className="text-[11px] font-poppins text-muted-foreground truncate max-w-[180px]">{v.email ?? "—"}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <button
                          onClick={() => onViewVendor(v.id)}
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
                      <span className="text-[11px] font-poppins text-muted-foreground">{v.location ?? "—"}</span>
                      <span className="text-[11px] font-poppins text-muted-foreground">{v.phone ?? "—"}</span>
                      <span className="text-[11px] font-poppins text-muted-foreground">{v.joiningDate ?? "—"}</span>
                    </div>
                  </div>
                ))}
            {!vendorsLoading && rows.length === 0 && (
              <p className="py-10 text-center text-[13px] font-poppins text-muted-foreground">No vendors found.</p>
            )}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-1.5 px-5 py-4 border-t border-border">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
            >‹</button>
            {pageNums.map((n, idx) =>
              n === "…" ? (
                <span key={`e-${idx}`} className="w-7 h-7 flex items-center justify-center text-[12px] font-poppins text-muted-foreground">…</span>
              ) : (
                <button
                  key={n}
                  onClick={() => setPage(n as number)}
                  className={`w-7 h-7 flex items-center justify-center rounded-[6px] text-[12px] font-poppins font-medium transition-colors ${
                    page === n ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:border-primary hover:text-primary"
                  }`}
                >{n}</button>
              )
            )}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-border hover:border-primary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-muted-foreground"
            >›</button>
          </div>
        )}
      </div>
    </div>
  );
}