import StatCards from "@/components/dashboard/StatCards";
import PlatformUsageChart from "@/components/dashboard/PlatformUsageChart";
import UserActivityChart from "@/components/dashboard/UserActivityChart";
import MembershipActivityChart from "@/components/dashboard/MembershipActivityChart";
import RevenueTracking from "@/components/dashboard/RevenueTracking";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="flex flex-col min-[1014px]:flex-row gap-4">
        <div className="flex flex-col gap-4 min-w-0 flex-1">
          <div className="grid grid-cols-2 sm:grid-cols-6 min-[1014px]:grid-cols-5 gap-3">
            <StatCards />
          </div>
          <PlatformUsageChart />
        </div>
       <div className="flex flex-col gap-4 min-[1014px]:w-[200px] min-[1014px]:shrink-0">
  <UserActivityChart />
  <MembershipActivityChart />
</div>
      </div>
      <RevenueTracking />
    </div>
  );
}