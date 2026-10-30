// src/components/marketing/overview/PlatformIntegration.tsx
"use client";

import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect } from "react";

export default function PlatformIntegration() {
  const {
    socialAccounts,
    isLoadingSocialAccounts,
    fetchSocialAccounts,
  } = useMarketingStore();

useEffect(() => {
    if (socialAccounts.length === 0) {
      fetchSocialAccounts();
    }
    
  }, []);

  if (isLoadingSocialAccounts && socialAccounts.length === 0) {
    return (
      <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col gap-4 h-full">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
    );
  }

  const platforms = socialAccounts.map(account => account.platform);

  return (
    <div className="relative bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col gap-4 h-full overflow-hidden">
      <div className="flex items-center justify-between">
        <h3 className="font-poppins text-[13px] font-semibold text-muted-foreground/70">
          Platform Integration
        </h3>
        <span className="font-poppins text-[10px] font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
          {socialAccounts.length > 0 ? `${socialAccounts.length} Connected` : "Coming Soon"}
        </span>
      </div>

      <div className="flex flex-col gap-3 opacity-60 pointer-events-none select-none">
        {platforms.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm py-4">
            No platforms connected
          </div>
        ) : (
          platforms.map((p) => (
            <div key={p} className="flex items-center justify-between">
              <span className="font-poppins text-[12px] text-foreground">{p}</span>
              <span className="font-poppins text-[10px] font-semibold text-muted-foreground bg-muted border border-border px-2.5 py-1 rounded-full">
                Connected
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}