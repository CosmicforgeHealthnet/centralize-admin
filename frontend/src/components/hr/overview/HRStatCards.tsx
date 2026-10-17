"use client";

import { useEffect } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";

// ─── Mock Salary Data (kept as mock for now) ─────────────────────────────────

const MOCK_SALARY_STATS = {
  averageSalary: "319",
  totalSalaryPayout: "25",
};

// ─── Mini Spark Line SVG ──────────────────────────────────────────────────────

function SparkLine({ color }: { color: string }) {
  return (
    <svg width="60" height="32" viewBox="0 0 60 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M0 28 C10 20, 15 8, 25 12 C35 16, 40 4, 60 2"
        stroke={color}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M0 28 C10 20, 15 8, 25 12 C35 16, 40 4, 60 2 L60 32 L0 32 Z"
        fill={color}
        fillOpacity="0.08"
      />
    </svg>
  );
}

// ─── Donut Chart SVG ──────────────────────────────────────────────────────────

function DonutChart() {
  const segments = [
    { value: 45, color: "#272EA7" },
    { value: 25, color: "#F59E0B" },
    { value: 20, color: "#EF4444" },
    { value: 10, color: "#10B981" },
  ];
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = 22;
  const cx = 28;
  const cy = 28;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const arcs = segments.map((seg) => {
    const dash = (seg.value / total) * circumference;
    const gap = circumference - dash;
    const arc = { dash, gap, offset, color: seg.color };
    offset += dash;
    return arc;
  });

  return (
    <svg width="56" height="56" viewBox="0 0 56 56">
      {arcs.map((arc, i) => (
        <circle
          key={i}
          cx={28}
          cy={28}
          r={22}
          fill="none"
          stroke={arc.color}
          strokeWidth="7"
          strokeDasharray={`${arc.dash} ${arc.gap}`}
          strokeDashoffset={-arc.offset}
          transform={`rotate(-90 28 28)`}
        />
      ))}
      <text x={28} y={29} textAnchor="middle" dominantBaseline="middle" fontSize="9" fontWeight="700" fill="#272EA7">
        $7k
      </text>
    </svg>
  );
}

// ─── Employment Type Filter Pills ─────────────────────────────────────────────

function FilterPills({ options, active }: { options: string[]; active: string }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {options.map((opt) => (
        <button
          key={opt}
          className={`px-3 py-1 rounded-full text-[11px] font-poppins font-medium transition-colors ${
            opt === active
              ? "bg-primary text-white"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

// ─── Wide Stat Card (Employee Overview) ───────────────────────────────────────

function WideStatCard({ totalEmployees, isLoading }: { totalEmployees: number; isLoading: boolean }) {
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)]">
      <p className="font-poppins text-[12px] font-medium text-muted-foreground mb-1">
        Employee Overview
      </p>
      <div className="flex items-end gap-3 flex-wrap">
        <span className="font-poppins text-[28px] font-bold text-foreground leading-none">
          {isLoading ? "..." : totalEmployees.toLocaleString()}
        </span>
        <div className="flex items-center gap-1 mb-0.5">
          <TrendingUp className="w-3.5 h-3.5 text-green-500" />
          <span className="font-poppins text-[11px] font-semibold text-green-500">+10%</span>
          <span className="font-poppins text-[11px] text-muted-foreground">from last month</span>
        </div>
      </div>
      <p className="font-poppins text-[11px] text-muted-foreground mt-1 mb-2">
        Select by Employment Type
      </p>
      <FilterPills
        options={["Full Time", "Part Time", "Remote", "Hybrid", "On-site"]}
        active="Full Time"
      />
    </div>
  );
}

// ─── Mini Stat Card ───────────────────────────────────────────────────────────

function MiniStatCard({
  label,
  value,
  change,
  trend,
  subtitle,
  donut,
  isLoading,
}: {
  label: string;
  value: string | number;
  change: string;
  trend: "up" | "down";
  subtitle: string;
  donut?: boolean;
  isLoading?: boolean;
}) {
  const isUp = trend === "up";
  const displayValue = isLoading ? "..." : value;

  return (
    <div className="bg-card rounded-xl border border-border p-3.5 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex items-center justify-between gap-2">
      <div className="flex flex-col min-w-0">
        <p className="font-poppins text-[11px] font-medium text-muted-foreground truncate">{label}</p>
        <span className="font-poppins text-[22px] font-bold text-foreground leading-tight mt-0.5">
          {displayValue}
        </span>
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          {isUp ? (
            <TrendingUp className="w-3 h-3 text-green-500 shrink-0" />
          ) : (
            <TrendingDown className="w-3 h-3 text-red-500 shrink-0" />
          )}
          <span
            className={`font-poppins text-[10px] font-semibold ${
              isUp ? "text-green-500" : "text-red-500"
            }`}
          >
            {change}
          </span>
          <span className="font-poppins text-[10px] text-muted-foreground">{subtitle}</span>
        </div>
      </div>
      <div className="shrink-0">
        {donut ? <DonutChart /> : <SparkLine color="#272EA7" />}
      </div>
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function HRStatCards() {
  const {
    performanceStats,
    isLoadingPerformanceStats,
    leaveStats,
    isLoadingLeaveStats,
    attendanceStats,
    isLoadingAttendanceStats,
    fetchPerformanceStats,
    fetchLeaveStats,
    fetchAttendanceStats,
  } = useHrmStore();

  useEffect(() => {
    fetchPerformanceStats();
    fetchLeaveStats();
    fetchAttendanceStats();
  }, []);

  // Real data
  const totalEmployees = performanceStats?.totalEmployees || 0;
  const pendingLeaves = leaveStats?.pendingRequests || 0;
  const totalPresent = attendanceStats?.totalPresent || 0;

  // ─── MOCK SALARY DATA (kept as mock) ──────────────────────────────────────────
  const mockAverageSalary = MOCK_SALARY_STATS.averageSalary;
  const mockTotalSalaryPayout = MOCK_SALARY_STATS.totalSalaryPayout;

  return (
    <div className="flex flex-col gap-3">
      {/* Top row: wide card + 2 mini cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <WideStatCard
          totalEmployees={totalEmployees}
          isLoading={isLoadingPerformanceStats}
        />

        <MiniStatCard
          label="Attendance"
          value={totalPresent}
          change="-10%"
          trend="down"
          subtitle="from last week"
          isLoading={isLoadingAttendanceStats}
        />

        <MiniStatCard
          label="New Hires"
          value="25"
          change="+10%"
          trend="up"
          subtitle="from last month"
          isLoading={isLoadingPerformanceStats}
        />
      </div>

      {/* Bottom row: 4 donut cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniStatCard
          label="New Employee"
          value="319"
          change="-10%"
          trend="down"
          subtitle="from last week"
          donut
        />

        <MiniStatCard
          label="Employee on Leave"
          value={pendingLeaves}
          change="-10%"
          trend="down"
          subtitle="from last month"
          donut
          isLoading={isLoadingLeaveStats}
        />

        {/* ─── MOCK: Average Salary ─────────────────────────────────────────────── */}
        <MiniStatCard
          label="Average Salary"
          value={mockAverageSalary}
          change="-10%"
          trend="down"
          subtitle="from last week"
          donut
        />

        {/* ─── MOCK: Total Salary Payout ─────────────────────────────────────────── */}
        <MiniStatCard
          label="Total Salary Payout"
          value={mockTotalSalaryPayout}
          change="+10%"
          trend="up"
          subtitle="from last month"
          donut
        />
      </div>
    </div>
  );
}