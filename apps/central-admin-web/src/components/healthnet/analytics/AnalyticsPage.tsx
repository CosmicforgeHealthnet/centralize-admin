"use client";

import AnalyticsStatCards from "./AnalyticsStatCards";
import AnalyticsDoctorsChart from "./AnalyticsDoctorsChart";
import AnalyticsPatientsStatChart from "./AnalyticsPatientsStatChart";
import AnalyticsBarChart from "./AnalyticsBarChart";
import AnalyticsAreaChart from "./AnalyticsAreaChart";

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col gap-5">
      {/* Page title */}
      <div>
        <h1 className="text-[20px] font-poppins font-bold text-gray-900">Analytics</h1>
        <p className="text-[13px] font-poppins text-gray-400 mt-0.5">
          In-depth performance metrics across your healthcare platform.
        </p>
      </div>

      {/* Stat cards */}
      <AnalyticsStatCards />

      {/* Doctors donut + Patients bar — side by side on large screens */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AnalyticsDoctorsChart />
        <AnalyticsPatientsStatChart />
      </div>

      {/* Revenue tracking — dual bar (Appointments + Sales) */}
      <AnalyticsBarChart
        title="Revenue Tracking"
        subtitle="Revenue Performance and Report"
        variant="dual"
        primaryLabel="Appointments"
        secondaryLabel="Sales"
        primaryColor="#272EA7"
        secondaryColor="#22C55E"
      />

      {/* Appointments overview — single bar */}
      <AnalyticsBarChart
        title="Appointments Overview"
        subtitle="Appointment Performance and Report"
        variant="single"
        primaryLabel="Appointments"
        primaryColor="#272EA7"
      />

      {/* Revenue tracking v2 — dual bar (same design, different data emphasis) */}
      {/* <AnalyticsBarChart
        title="Revenue Tracking"
        subtitle="Revenue Performance and Report"
        variant="dual"
        primaryLabel="Appointments"
        secondaryLabel="Sales"
        primaryColor="#272EA7"
        secondaryColor="#22C55E"
      /> */}

      {/* Sales Analytics — area chart */}
      <AnalyticsAreaChart variant="sales" />

      {/* Delivery Overview — pink area chart */}
      <AnalyticsAreaChart variant="delivery" />

      {/* Billing & Memberships — green area chart */}
      <AnalyticsAreaChart variant="billing" />
    </div>
  );
}