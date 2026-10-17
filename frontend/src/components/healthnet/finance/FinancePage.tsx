"use client";

import FinanceStatCards from "./FinanceStatCards";
import FinanceRevenueChart from "./FinanceRevenueChart";
import FinancePerformanceOverview from "./FinancePerformanceOverview";

export default function FinancePage() {
  return (
    <div className="flex flex-col gap-5">
      {/* Page title */}
      <div>
        <h1 className="text-[20px] font-poppins font-bold text-gray-900">Finance</h1>
        <p className="text-[13px] font-poppins text-gray-400 mt-0.5">
          Track revenue, appointments, and financial performance.
        </p>
      </div>

      {/* Stat cards */}
      <FinanceStatCards />

      <FinanceRevenueChart mode="subscriptions" />

      {/* Performance overview table */}
      <FinancePerformanceOverview />
    </div>
  );
}