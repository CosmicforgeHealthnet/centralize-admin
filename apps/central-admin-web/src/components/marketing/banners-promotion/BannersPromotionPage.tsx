// src/components/marketing/banners-promotion/BannersPromotionPage.tsx
"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { Search, Edit, Trash2, ChevronLeft, ChevronRight, SlidersHorizontal, PlusCircle } from "lucide-react";
import CreatePromotionModal from "./CreatePromotionModal";
import EditPromotionModal from "./EditPromotionModal";
import NewBannerPage from "./NewBannerPage";
import BannerDetail from "./BannerDetail";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import type { PromotionListItem, BannerListItem } from "@/types/marketing.types";

type TabKey = "Ad Banners" | "All" | "Active Promotions" | "Upcoming Promotions" | "Ended Promotions";
const TABS: TabKey[] = ["All", "Ad Banners", "Active Promotions", "Upcoming Promotions", "Ended Promotions"];

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  Active: { bg: "rgba(13,165,63,0.1)", text: "#0DA53F" },
  Completed: { bg: "rgba(13,165,63,0.1)", text: "#0DA53F" },
  Ended: { bg: "rgba(246,69,69,0.1)", text: "#F64545" },
  Upcoming: { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  "Ending Soon": { bg: "rgba(232,182,0,0.12)", text: "#E8B600" },
  Inactive: { bg: "rgba(156,163,175,0.1)", text: "#9CA3AF" },
  Expired: { bg: "rgba(246,69,69,0.1)", text: "#F64545" },
};

export default function BannersPromotionPage() {
  const [tab, setTab] = useState<TabKey>("Ad Banners");
  const [search, setSearch] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingPromotion, setEditingPromotion] = useState<PromotionListItem | null>(null);
  const [view, setView] = useState<"list" | "new-banner" | "banner-detail">("list");
  const [selectedBannerId, setSelectedBannerId] = useState<string | null>(null);

  const {
    promotions,
    promotionStats,
    promotionPagination,
    promotionFilters,
    banners,
    bannerPagination,
    bannerFilters,
    isLoadingPromotions,
    isLoadingBanners,
    selectedBanner,
    isLoadingBannerDetail,
    error,
    fetchPromotions,
    setPromotionFilters,
    fetchBanners,
    setBannerFilters,
    fetchBannerDetail,
    deletePromotion,
    deleteBanner,
    updateBannerStatus,
    clearError,
  } = useMarketingStore();

  useEffect(() => {
    if (tab === "Ad Banners") {
      fetchBanners();
    } else {
      fetchPromotions();
    }
  }, [tab, promotionFilters, bannerFilters, fetchPromotions, fetchBanners]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  const handleSearch = () => {
    if (tab === "Ad Banners") {
      setBannerFilters({ search, page: 1 });
    } else {
      setPromotionFilters({ search, page: 1 });
    }
  };

  const handleTabChange = (newTab: TabKey) => {
    setTab(newTab);
    if (newTab === "Ad Banners") {
      setBannerFilters({ page: 1 });
    } else {
      setPromotionFilters({ tab: newTab, page: 1 });
    }
  };

  const showAdBanners = tab === "Ad Banners";

  const handleBannerClick = async (id: string) => {
    setSelectedBannerId(id);
    await fetchBannerDetail(id);
    setView("banner-detail");
  };

  const handleBackFromDetail = () => {
    setView("list");
    setSelectedBannerId(null);
  };

  if (view === "new-banner") {
    return <NewBannerPage onBack={() => setView("list")} />;
  }

  if (view === "banner-detail" && selectedBanner) {
    return <BannerDetail onBack={handleBackFromDetail} />;
  }

  const isLoading = showAdBanners ? isLoadingBanners : isLoadingPromotions;
  const items = showAdBanners ? banners : promotions;
  const pagination = showAdBanners ? bannerPagination : promotionPagination;

  if (isLoading && items.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32 mt-1" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[100px] rounded-xl" />
          ))}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-wrap">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-48 flex-1" />
          <Skeleton className="h-10 w-24 ml-auto" />
        </div>
        <Skeleton className="h-[400px] rounded-xl" />
      </div>
    );
  }

  const filteredPromotions = promotions.filter((p) => {
    if (tab === "Active Promotions") return p.status === "Active" || p.status === "Completed";
    if (tab === "Upcoming Promotions") return p.status === "Upcoming";
    if (tab === "Ended Promotions") return p.status === "Completed" || p.status === "Ended";
    return true;
  }).filter((p) => p.title.toLowerCase().includes(search.toLowerCase()));

  const displayItems = showAdBanners ? banners : filteredPromotions;

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div>
        <h2 className="font-poppins text-[16px] font-semibold text-foreground">Banners & Promotion</h2>
        <p className="font-poppins text-[12px] text-muted-foreground mt-0.5">Auto-Updates in 2 minutes</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: "Total Promotions", value: promotionStats?.totalPromotions?.toLocaleString() || "0" },
          { label: "Engagement Rate", value: promotionStats?.engagementRate || "0%" },
          { label: "Revenue", value: promotionStats?.revenue || "$0" },
        ].map(({ label, value }) => (
          <div key={label} className="bg-card rounded-xl border border-border p-4 flex flex-col gap-2">
            <span className="font-poppins text-[12px] text-muted-foreground">{label}</span>
            <span className="font-poppins text-[22px] font-bold text-foreground">{value}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-wrap">
        <h3 className="font-poppins text-[14px] font-semibold text-foreground mr-2">
          {showAdBanners ? "Ad Banner" : "Promotions List"}
        </h3>

        <div className="flex items-center gap-1.5 flex-wrap">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => handleTabChange(t)}
              className={`px-3.5 py-1.5 rounded-full text-[12px] font-poppins font-medium transition-colors whitespace-nowrap ${
                tab === t ? "bg-primary text-white" : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search"
            className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
          />
          <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        </div>

        <button
          onClick={() => (showAdBanners ? setView("new-banner") : setShowCreateModal(true))}
          className="px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors h-[36px] sm:ml-auto whitespace-nowrap flex items-center gap-1.5"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          Add New
        </button>
      </div>

      {showAdBanners ? (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {["Media", "Title", "Description", "Display", "External Link", "Status", "Action"].map((h) => (
                    <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-muted-foreground font-poppins text-[12px]">
                      {isLoading ? "Loading..." : "No banners found"}
                    </td>
                  </tr>
                ) : (
                  (displayItems as BannerListItem[]).map((b) => (
                    <tr
                      key={b.id}
                      className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
                      onClick={() => handleBannerClick(b.id)}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <div className="w-9 h-9 rounded overflow-hidden shrink-0 bg-muted flex items-center justify-center">
                            <span className="text-[10px] text-muted-foreground font-medium">
                              {b.mediaType || "IMG"}
                            </span>
                          </div>
                          <span className="font-poppins text-[12px] text-foreground">{b.mediaType || "Image"}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{b.title || "—"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap max-w-[150px] truncate">
                        {b.description || "—"}
                      </td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{b.display || "WEB"}</td>
                      <td className="py-3 px-4 font-poppins text-[12px] text-muted-foreground whitespace-nowrap truncate max-w-[120px]">
                        {b.externalLink || "—"}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-semibold ${
                          b.status === "Active" ? "bg-green-500/10 text-green-500" : 
                          b.status === "Expired" ? "bg-red-500/10 text-red-500" :
                          "bg-muted text-muted-foreground"
                        }`}>
                          {b.status}
                        </span>
                      </td>
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2.5">
                          <button
                            onClick={() => handleBannerClick(b.id)}
                            className="text-primary hover:text-primary/70 transition-colors"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => deleteBanner(b.id)}
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
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {["Promotion Title", "Discount Type", "Start Date", "End Date", "Gross Sales", "Average Rate", "Gross Revenue", "Status", "Action"].map((h) => (
                    <th key={h} className="text-left py-2.5 px-4 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayItems.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center py-12 text-muted-foreground font-poppins text-[12px]">
                      {isLoading ? "Loading..." : "No promotions found"}
                    </td>
                  </tr>
                ) : (
                  (displayItems as PromotionListItem[]).map((p) => {
                    const st = STATUS_STYLES[p.status] || STATUS_STYLES["Active"];
                    return (
                      <tr key={p.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                        <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{p.title}</td>
                        <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{p.discountType}</td>
                        <td className="py-3 px-4 font-poppins text-[12px] text-muted-foreground whitespace-nowrap">{p.startDate || "—"}</td>
                        <td className="py-3 px-4 font-poppins text-[12px] text-muted-foreground whitespace-nowrap">{p.endDate || "—"}</td>
                        <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{p.grossSales || "—"}</td>
                        <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{p.averageRate || "—"}</td>
                        <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{p.grossRevenue || "—"}</td>
                        <td className="py-3 px-4">
                          <span
                            className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap"
                            style={{ backgroundColor: st.bg, color: st.text }}
                          >
                            {p.status}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2.5">
                            <button
                              onClick={() => setEditingPromotion(p)}
                              className="text-primary hover:text-primary/70 transition-colors"
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => deletePromotion(p.id)}
                              className="text-red-500 hover:text-red-400 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
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

          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-end gap-1 px-4 py-4">
              <button
                onClick={() => setPromotionFilters({ page: Math.max(1, promotionFilters.page - 1) })}
                disabled={promotionFilters.page <= 1}
                className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4 text-foreground" />
              </button>
              {Array.from({ length: Math.min(5, pagination.totalPages) }).map((_, i) => {
                const p = i + 1;
                return (
                  <button
                    key={p}
                    onClick={() => setPromotionFilters({ page: p })}
                    className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                      promotionFilters.page === p ? "bg-primary text-white" : "text-foreground hover:bg-muted"
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
              {pagination.totalPages > 5 && (
                <>
                  <span className="font-poppins text-[12px] text-muted-foreground px-1">...</span>
                  <button
                    onClick={() => setPromotionFilters({ page: pagination.totalPages })}
                    className={`w-7 h-7 flex items-center justify-center rounded-md text-[12px] font-poppins font-semibold transition-colors ${
                      promotionFilters.page === pagination.totalPages ? "bg-primary text-white" : "text-foreground hover:bg-muted"
                    }`}
                  >
                    {pagination.totalPages}
                  </button>
                </>
              )}
              <button
                onClick={() => setPromotionFilters({ page: Math.min(pagination.totalPages, promotionFilters.page + 1) })}
                disabled={promotionFilters.page >= pagination.totalPages}
                className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4 text-foreground" />
              </button>
            </div>
          )}
        </div>
      )}

      {showCreateModal && <CreatePromotionModal onClose={() => setShowCreateModal(false)} />}
      {editingPromotion && (
        <EditPromotionModal
          promotion={editingPromotion}
          onClose={() => setEditingPromotion(null)}
        />
      )}
    </div>
  );
}