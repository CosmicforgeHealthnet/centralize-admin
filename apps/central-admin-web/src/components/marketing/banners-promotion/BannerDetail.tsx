// src/components/marketing/banners-promotion/BannerDetail.tsx
"use client";

import { useEffect } from "react";
import Image from "next/image";
import { ArrowLeft, Edit, Trash2 } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  onBack: () => void;
}

export default function BannerDetail({ onBack }: Props) {
  const {
    selectedBanner,
    isLoadingBannerDetail,
    deleteBanner,
    updateBannerStatus,
    error,
    clearError,
  } = useMarketingStore();

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  if (isLoadingBannerDetail || !selectedBanner) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-32" />
        <div>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32 mt-1" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
          <Skeleton className="h-[400px] rounded-xl" />
          <div className="flex flex-col gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const banner = selectedBanner;

  const handleDelete = async () => {
    if (confirm("Are you sure you want to delete this banner?")) {
      await deleteBanner(banner.id);
      onBack();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Banners & Promotion</span>
      </button>

      <div>
        <h2 className="font-poppins text-[16px] font-semibold text-foreground">View Banner</h2>
        <p className="font-poppins text-[12px] text-muted-foreground mt-0.5">Auto-Updates in 2 minutes</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
        <div className="rounded-xl overflow-hidden bg-muted h-[400px] sm:h-[520px]">
          {banner.imageUrl ? (
            <Image
              src={banner.imageUrl}
              alt={banner.title || "Banner"}
              width={900}
              height={900}
              className="object-cover w-full h-full"
              unoptimized
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              No image available
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {[
            { label: "Ad Banner Title", value: banner.title || "Enter Banner Title" },
            { label: "Description", value: banner.description || "No description" },
            { label: "Display Settings", value: banner.display || "WEB" },
            { label: "Placement", value: banner.placement || "Website" },
            { label: "External Link", value: banner.externalLink || "—" },
            { label: "Start Date", value: banner.startDate || "—" },
            { label: "End Date", value: banner.endDate || "—" },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="font-poppins text-[12px] font-semibold text-foreground">{label}</span>
              <span className="font-poppins text-[12px] text-muted-foreground">{value}</span>
            </div>
          ))}

          <div className="flex flex-col gap-1">
            <span className="font-poppins text-[12px] font-semibold text-foreground">Status</span>
            <div className="flex items-center gap-3">
              <span
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-semibold ${
                  banner.status === "Active" ? "bg-green-500/10 text-green-500" : 
                  banner.status === "Expired" ? "bg-red-500/10 text-red-500" :
                  "bg-muted text-muted-foreground"
                }`}
              >
                {banner.status}
              </span>
              {banner.status === "Inactive" && (
                <button
                  onClick={() => updateBannerStatus(banner.id, "Active")}
                  className="text-xs text-primary hover:underline"
                >
                  Activate
                </button>
              )}
              {banner.status === "Active" && (
                <button
                  onClick={() => updateBannerStatus(banner.id, "Inactive")}
                  className="text-xs text-yellow-500 hover:underline"
                >
                  Deactivate
                </button>
              )}
            </div>
          </div>

          {banner.performance && (
            <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
              <h3 className="font-poppins text-[13px] font-semibold text-foreground">Performance Data</h3>
              <div>
                <span className="font-poppins text-[11px] text-muted-foreground">Total Impressions</span>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-poppins text-[22px] font-bold text-foreground">
                    {banner.performance.totalImpressions}
                  </span>
                  <span className="font-poppins text-[10px] font-semibold text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">
                    ↑ {banner.performance.change}
                  </span>
                </div>
              </div>

              <div className="flex w-full h-1.5 rounded-full overflow-hidden">
                <div style={{ backgroundColor: "#EF4444", flex: 1 }} />
                <div style={{ backgroundColor: "#272EA7", flex: 1 }} />
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  <span className="font-poppins text-[11px] text-muted-foreground">Clicks</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-primary" />
                  <span className="font-poppins text-[11px] text-muted-foreground">Signup</span>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-poppins text-[12px] text-foreground">Clicks</span>
                  <div className="flex items-center gap-2">
                    <span className="font-poppins text-[12px] font-semibold text-foreground">
                      {banner.performance.clicks}
                    </span>
                    <span className={`font-poppins text-[10px] font-semibold ${
                      banner.performance.clicksChange?.startsWith("+") ? "text-green-500" : "text-red-500"
                    }`}>
                      {banner.performance.clicksChange}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-poppins text-[12px] text-foreground">Sign up</span>
                  <div className="flex items-center gap-2">
                    <span className="font-poppins text-[12px] font-semibold text-foreground">
                      {banner.performance.signup}
                    </span>
                    <span className={`font-poppins text-[10px] font-semibold ${
                      banner.performance.signupChange?.startsWith("+") ? "text-green-500" : "text-red-500"
                    }`}>
                      {banner.performance.signupChange}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handleDelete}
              className="px-5 py-2.5 border border-red-500 text-red-500 rounded-lg text-[13px] font-poppins font-semibold hover:bg-red-500/5 transition-colors flex items-center gap-1.5"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
            <button className="px-5 py-2.5 bg-primary text-white rounded-lg text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors flex items-center gap-1.5">
              <Edit className="w-4 h-4" />
              Edit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}