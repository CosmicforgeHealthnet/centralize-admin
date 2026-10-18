"use client";

import { useVerificationStore } from "@/stores/verification.store";
import { useStuckDoctorsStore } from "@/stores/useStuckDoctorsStore";

function UsersIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 9v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function StatCardSkeleton() {
  return (
    <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] animate-pulse">
      <div className="w-11 h-11 rounded-lg bg-muted shrink-0" />
      <div className="flex flex-col gap-2 flex-1">
        <div className="h-3 w-24 bg-muted rounded" />
        <div className="h-6 w-12 bg-muted rounded" />
      </div>
    </div>
  );
}

export default function VerificationStatCards() {
  const stats = useVerificationStore((s) => s.stats);
  const isLoading = useVerificationStore((s) => s.isLoadingList);
  const stuckStats = useStuckDoctorsStore((s) => s.stats);
  const isLoadingStuck = useStuckDoctorsStore((s) => s.isLoading);

  const statItems = [
    { label: "Total Requests",   value: stats?.totalRequests   ?? "—" },
    { label: "Approval Rate",    value: stats?.approvalRate    ?? "—" },
    { label: "Pending Requests", value: stats?.pendingRequests ?? "—" },
    { label: "Stuck Doctors",    value: stuckStats?.totalStuck ?? "—", icon: <AlertIcon /> },
  ];

  if ((isLoading && !stats) || (isLoadingStuck && !stuckStats)) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-5">
        {[0, 1, 2, 3].map((i) => <StatCardSkeleton key={i} />)}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-5">
      {statItems.map((stat) => (
        <div
          key={stat.label}
          className="bg-card rounded-xl border border-border p-4 flex items-center gap-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)]"
        >
          <div className={`w-11 h-11 rounded-lg flex items-center justify-center shrink-0 bg-muted ${
            stat.label === "Stuck Doctors" ? "text-amber-500" : "text-[#272EA7] dark:text-[#8b9cf4]"
          }`}>
            {stat.icon || <UsersIcon />}
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] font-poppins font-medium text-muted-foreground leading-none mb-1">
              {stat.label}
            </span>
            <span className="text-[20px] font-poppins font-bold text-foreground leading-tight">
              {String(stat.value)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}