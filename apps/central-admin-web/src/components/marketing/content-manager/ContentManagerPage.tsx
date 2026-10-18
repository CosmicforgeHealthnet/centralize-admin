// src/components/marketing/content-manager/ContentManagerPage.tsx
"use client";

import { useState, useEffect } from "react";
import { Search, Edit, Trash2, PlusCircle } from "lucide-react";
import CreateContentModal from "./CreateContentModal";
import ContentDetail from "./ContentDetail";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import type { ContentListItem } from "@/types/marketing.types";

export default function ContentManagerPage() {
  const [tab, setTab] = useState<"Sent" | "Draft">("Sent");
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);

  const {
    contentItems,
    contentCounts,
    contentPagination,
    contentFilters,
    isLoadingContent,
    error,
    fetchContentItems,
    setContentFilters,
    deleteContent,
    clearError,
  } = useMarketingStore();

  useEffect(() => {
    fetchContentItems();
  }, [contentFilters, fetchContentItems]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  const handleSearch = () => {
    setContentFilters({ search, page: 1 });
  };

  const handleTabChange = (newTab: "Sent" | "Draft") => {
    setTab(newTab);
    const status = newTab === "Sent" ? "Published" : "Draft";
    setContentFilters({ status, page: 1 });
  };

  const toggleRow = (id: string) => {
    setSelectedRows((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]
    );
  };

  const selected = contentItems.find((c) => c.id === selectedId) ?? null;

  if (selectedId && selected) {
    return <ContentDetail contentId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  const sentCount = contentCounts?.sent || 0;
  const draftCount = contentCounts?.draft || 0;
  const filteredItems = contentItems;

  if (isLoadingContent && contentItems.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64 mt-1" />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-wrap">
          <Skeleton className="h-10 w-32 rounded-lg" />
          <Skeleton className="h-10 w-48 rounded-lg flex-1" />
          <Skeleton className="h-10 w-20 rounded-lg" />
          <Skeleton className="h-10 w-32 rounded-lg ml-auto" />
        </div>
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="p-8 flex items-center justify-center">
            <Skeleton className="h-[400px] w-full" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div>
        <h2 className="font-poppins text-[16px] font-semibold text-foreground">Grow your business further</h2>
        <p className="font-poppins text-[12px] text-muted-foreground mt-0.5">
          Powerful content for engagement, business growth and lasting success
        </p>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-wrap">
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1 w-fit">
          <button
            onClick={() => handleTabChange("Sent")}
            className={`px-4 py-1.5 rounded-md text-[12px] font-poppins font-semibold transition-colors ${
              tab === "Sent" ? "bg-primary text-white" : "text-muted-foreground"
            }`}
          >
            Sent <span className="opacity-80">{sentCount}</span>
          </button>
          <button
            onClick={() => handleTabChange("Draft")}
            className={`px-4 py-1.5 rounded-md text-[12px] font-poppins font-semibold transition-colors ${
              tab === "Draft" ? "bg-primary text-white" : "text-muted-foreground"
            }`}
          >
            Draft <span className="opacity-80">{draftCount}</span>
          </button>
        </div>

        <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[38px] flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search here..."
            className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
          />
        </div>

        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors h-[38px]"
        >
          Search
        </button>

        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors h-[38px] ml-auto flex items-center gap-1.5"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          Create Content
        </button>
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="w-10 py-2.5 px-4" />
                {["Title", "Content Type", "Author", "Status", "Updated", "Performance", "Action"].map((h) => (
                  <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-muted-foreground font-poppins text-[12px]">
                    {isLoadingContent ? "Loading..." : "No content found"}
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
                    onClick={() => setSelectedId(item.id)}
                  >
                    <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedRows.includes(item.id)}
                        onChange={() => toggleRow(item.id)}
                        className="w-4 h-4 rounded border-border accent-primary cursor-pointer"
                      />
                    </td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap max-w-[150px] truncate">
                      {item.title}
                    </td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{item.type}</td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-primary underline whitespace-nowrap">
                      {item.author}
                    </td>
                    <td className="py-3 px-4 font-poppins text-[12px] whitespace-nowrap">
                      <span className={item.status === "Published" ? "text-green-500 font-semibold" : "text-muted-foreground font-semibold"}>
                        {item.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-muted-foreground whitespace-nowrap">
                      {item.updatedAt || "—"}
                    </td>
                    <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">
                      {item.performance}%
                    </td>
                    <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2.5">
                        <button
                          onClick={() => setSelectedId(item.id)}
                          className="text-primary hover:text-primary/70 transition-colors"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => deleteContent(item.id)}
                          className="text-red-500 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <CreateContentModal onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}