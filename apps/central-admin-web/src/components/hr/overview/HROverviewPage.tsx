"use client";

import HRStatCards from "./HRStatCards";
import HRSalaryChart from "./HRSalaryChart";
import HRPerformanceChart from "./HRPerformanceChart";
import HREmployeeList from "./HREmployeeList";

export default function HROverviewPage() {
  return (
    <div className="flex flex-col gap-5">
      {/* Stat Cards */}
      <HRStatCards />

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <HRSalaryChart />
        <HRPerformanceChart />
      </div>

      {/* Employee List */}
      <HREmployeeList />
    </div>
  );
}