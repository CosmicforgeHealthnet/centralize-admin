"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import VerificationSubNav from "./VerificationSubNav";
import VerificationFiltersBar from "./VerificationFilters";
import VerificationStatCards from "./VerificationStatCards";
import VerificationTable from "./VerificationTable";
import { useVerificationStore } from "@/stores/verification.store";
import { useStuckDoctorsStore } from "@/stores/useStuckDoctorsStore";

export default function VerificationPage() {
  const setActiveRole = useVerificationStore((s) => s.setActiveRole);
  const resetFilters = useVerificationStore((s) => s.resetFilters);
  const fetchList = useVerificationStore((s) => s.fetchList);
  const activeRole = useVerificationStore((s) => s.activeRole);
  const fetchStuck = useStuckDoctorsStore((s) => s.fetch);

  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = () => {
    setIsRefreshing(true);
    resetFilters();
    setActiveRole("All");
    fetchList();
    if (activeRole === "Stuck") {
      fetchStuck();
    }
    setRefreshKey((k) => k + 1);
    setTimeout(() => setIsRefreshing(false), 600);
  };

  return (
    <div className="flex flex-col gap-4 min-[1014px]:flex-row min-[1014px]:items-start">
      <VerificationSubNav />

      <div className="flex-1 min-w-0 bg-card border border-border rounded-[12px] overflow-hidden">
        <div className="px-4 sm:px-5 pt-4 sm:pt-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-[15px] font-poppins font-semibold text-foreground">
                {activeRole === "Stuck" ? "Stuck Doctors" : "Verification Statistics"}
              </h1>
              <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">
                {activeRole === "Stuck" 
                  ? "Doctors stuck in pending verification with no verification request"
                  : "Monitor verification performance and analytics"
                }
              </p>
            </div>
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-[#1c3866] text-white text-[12px] font-poppins font-medium rounded-md hover:bg-[#162d52] transition-all"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>

          {activeRole !== "Stuck" && <VerificationFiltersBar />}

          <div className="border-b border-border mt-4" />
        </div>

        <div className="flex flex-col gap-5 p-4 sm:p-5">
          <VerificationStatCards key={refreshKey} />
          <VerificationTable key={`table-${refreshKey}`} />
        </div>
      </div>
    </div>
  );
}