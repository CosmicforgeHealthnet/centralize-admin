"use client";
import type { AdminChartTooltipProps } from "@/types/chart-tooltip.types";

import { useEffect, useState } from "react";
import Image from "next/image";
import { TrendingUp, TrendingDown, ChevronDown } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import LeaveRequestDetail from "./LeaveRequestDetail";
import { useHrmStore } from "@/stores/hrm.store";
import { LeaveStatus } from "@/types/hrm.types";

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label }: AdminChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
      <p className="font-poppins text-[11px] text-muted-foreground mb-0.5">{label}</p>
      <p className="font-poppins text-[12px] font-semibold text-foreground">{payload[0].value}%</p>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ 
  label, 
  value, 
  change, 
  trend, 
  subtitle, 
  borderColor 
}: { 
  label: string;
  value: string | number;
  change: string;
  trend: "up" | "down";
  subtitle: string;
  borderColor: string;
}) {
  const isUp = trend === "up";
  return (
    <div
      className="bg-card rounded-xl border border-border p-4 flex flex-col gap-1 relative overflow-hidden"
    >
      <p className="font-poppins text-[12px] font-semibold text-foreground">{label}</p>
      <span className="font-poppins text-[28px] font-bold text-foreground leading-none">{value}</span>
      <div className="flex items-center gap-1 flex-wrap mt-0.5">
        {isUp
          ? <TrendingUp   className="w-3 h-3 text-green-500 shrink-0" />
          : <TrendingDown className="w-3 h-3 text-red-500 shrink-0"   />
        }
        <span className={`font-poppins text-[10px] font-semibold ${isUp ? "text-green-500" : "text-red-500"}`}>
          {change}
        </span>
        <span className="font-poppins text-[10px] text-muted-foreground">{subtitle}</span>
      </div>
      <div
        className="absolute bottom-0 left-0 right-0 h-[3px] rounded-b-xl"
        style={{ backgroundColor: borderColor }}
      />
    </div>
  );
}

// ─── Leave Request Card ───────────────────────────────────────────────────────

function LeaveRequestCard({
  id,
  name,
  email,
  leaveType,
  startDate,
  resumptionDate,
  status,
  avatarUrl,
  onClick,
  onApprove,
  onDeny,
  isUpdating,
}: {
  id: string;
  name: string | null;
  email: string | null;
  leaveType: string;
  startDate: string | null;
  resumptionDate: string | null;
  status: LeaveStatus;
  avatarUrl: string | null;
  onClick: () => void;
  onApprove: () => void;
  onDeny: () => void;
  isUpdating: boolean;
}) {
  const formatDate = (date: string | null) => {
    if (!date) return "N/A";
    return new Date(date).toLocaleDateString('en-US', { 
      month: 'long', 
      day: 'numeric',
      year: 'numeric'
    });
  };

  const isPending = status === "PENDING";

  return (
    <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-muted">
            {avatarUrl ? (
              <Image src={avatarUrl} alt={name || 'User'} width={32} height={32} className="object-cover w-full h-full" />
            ) : (
              <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                <span className="text-[12px] font-poppins font-bold text-primary">{name?.charAt(0) || '?'}</span>
              </div>
            )}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-poppins text-[12px] font-semibold text-foreground truncate">{name || 'Unknown'}</span>
            <span className="font-poppins text-[10px] text-muted-foreground truncate">{email || 'No email'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] font-poppins font-semibold px-2 py-0.5 rounded-full ${
            status === "APPROVED" ? "bg-green-100 text-green-700" :
            status === "DENIED" ? "bg-red-100 text-red-700" :
            "bg-yellow-100 text-yellow-700"
          }`}>
            {status}
          </span>
        </div>
      </div>

      <div className="flex items-end justify-between gap-2 flex-wrap">
        <div
          className="flex flex-col gap-0.5 cursor-pointer hover:opacity-80 transition-opacity"
          onClick={onClick}
        >
          <span className="font-poppins text-[12px] font-semibold text-foreground">{leaveType}</span>
          <span className="font-poppins text-[11px] text-muted-foreground">
            {formatDate(startDate)} - {formatDate(resumptionDate)}
          </span>
        </div>
        {isPending && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onDeny}
              disabled={isUpdating}
              className="h-[30px] px-4 rounded-lg border border-red-300 text-red-500 text-[11px] font-poppins font-semibold hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Deny
            </button>
            <button
              onClick={onApprove}
              disabled={isUpdating}
              className="h-[30px] px-4 rounded-lg bg-green-500 text-white text-[11px] font-poppins font-semibold hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Approve
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function LeavesPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [period, setPeriod] = useState("September");

  const {
    leaveStats,
    isLoadingLeaveStats,
    leaveChart,
    isLoadingLeaveChart,
    leaves,
    leavesMeta,
    isLoadingLeaves,
    leavesFilters,
    isUpdatingLeave,
    leavesError,
    fetchLeaveStats,
    fetchLeaveChart,
    fetchLeaves,
    setLeavesFilters,
    setLeavesPage,
    approveLeave,
    denyLeave,
    approveAllLeaves,
  } = useHrmStore();

  useEffect(() => {
    fetchLeaveStats();
    fetchLeaveChart();
    fetchLeaves({ period });
  }, []);

  const handleApprove = async (id: string) => {
    await approveLeave(id);
  };

  const handleDeny = async (id: string) => {
    await denyLeave(id);
  };

  const handleApproveAll = async () => {
    await approveAllLeaves();
  };

  const handlePeriodChange = (value: string) => {
    setPeriod(value);
    fetchLeaves({ period: value, page: 1 });
  };

  const handlePageChange = (page: number) => {
    setLeavesPage(page);
  };

 if (selectedId) {
  return <LeaveRequestDetail leaveId={selectedId} onBack={() => setSelectedId(null)} />;
}

  // Calculate stats from real data
  const totalRequests = leaveStats?.totalRequests || 0;
  const newRequests = leaveStats?.newRequests || 0;
  const rejectedRequests = leaveStats?.rejectedRequests || 0;
  const pendingRequests = leaveStats?.pendingRequests || 0;

  const statCards = [
    { 
      label: "Total Request", 
      value: totalRequests, 
      change: `${leaveStats?.changes?.totalChange || 0}%`, 
      trend: (leaveStats?.changes?.totalChange || 0) >= 0 ? "up" as const : "down" as const, 
      subtitle: "from last week", 
      borderColor: "#272EA7" 
    },
    { 
      label: "New Request", 
      value: newRequests, 
      change: `${leaveStats?.changes?.newChange || 0}%`, 
      trend: (leaveStats?.changes?.newChange || 0) >= 0 ? "up" as const : "down" as const, 
      subtitle: "from last week", 
      borderColor: "#0DA53F" 
    },
    { 
      label: "Rejected Request", 
      value: rejectedRequests, 
      change: `${leaveStats?.changes?.rejectedChange || 0}%`, 
      trend: (leaveStats?.changes?.rejectedChange || 0) >= 0 ? "up" as const : "down" as const, 
      subtitle: "from last week", 
      borderColor: "#F64545" 
    },
    { 
      label: "Pending Request", 
      value: pendingRequests, 
      change: `${leaveStats?.changes?.pendingChange || 0}%`, 
      trend: (leaveStats?.changes?.pendingChange || 0) >= 0 ? "up" as const : "down" as const, 
      subtitle: "consistent with last week", 
      borderColor: "#E8B600" 
    },
  ];

  const chartData = leaveChart.length > 0 ? leaveChart : [];

  return (
    <div className="flex flex-col gap-5">
      {leavesError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {leavesError}
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map((card) => (
          <StatCard
            key={card.label}
            label={card.label}
            value={isLoadingLeaveStats ? "..." : card.value}
            change={card.change}
            trend={card.trend}
            subtitle={card.subtitle}
            borderColor={card.borderColor}
          />
        ))}
      </div>

      {/* Leaves Performance Chart */}
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">Leaves Performance</h3>
            <p className="font-poppins text-[11px] text-muted-foreground">Leaves Performance and Report</p>
          </div>
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors">
            Download Report <ChevronDown className="w-3 h-3" />
          </button>
        </div>

        {isLoadingLeaveChart ? (
          <div className="h-[220px] flex items-center justify-center">
            <span className="text-muted-foreground">Loading chart...</span>
          </div>
        ) : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} barSize={32} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(39,46,167,0.04)" }} />
              <Bar dataKey="value" name="Leave %" fill="rgba(39,46,167,0.25)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[220px] flex items-center justify-center">
            <span className="text-muted-foreground">No chart data available</span>
          </div>
        )}
      </div>

      {/* Leave Approval */}
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">Leave Approval</h3>
            <p className="font-poppins text-[11px] text-muted-foreground">Employee Leave Request List</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={period}
              onChange={(e) => handlePeriodChange(e.target.value)}
              className="text-[11px] font-poppins text-muted-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer"
            >
              <option value="January">January</option>
              <option value="February">February</option>
              <option value="March">March</option>
              <option value="April">April</option>
              <option value="May">May</option>
              <option value="June">June</option>
              <option value="July">July</option>
              <option value="August">August</option>
              <option value="September">September</option>
              <option value="October">October</option>
              <option value="November">November</option>
              <option value="December">December</option>
            </select>
            <button
              onClick={handleApproveAll}
              disabled={isUpdatingLeave || pendingRequests === 0}
              className="h-[32px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Approve All
            </button>
          </div>
        </div>

        {isLoadingLeaves ? (
          <div className="flex items-center justify-center h-40">
            <span className="text-muted-foreground">Loading leave requests...</span>
          </div>
        ) : leaves.length > 0 ? (
          <div className="flex flex-col gap-3 mt-3">
            {leaves.map((req) => (
              <LeaveRequestCard
                key={req.id}
                id={req.id}
                name={req.name}
                email={req.email}
                leaveType={req.leaveType}
                startDate={req.startDate}
                resumptionDate={req.resumptionDate}
                status={req.status}
                avatarUrl={req.avatarUrl}
                onClick={() => setSelectedId(req.id)}
                onApprove={() => handleApprove(req.id)}
                onDeny={() => handleDeny(req.id)}
                isUpdating={isUpdatingLeave}
              />
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center h-40">
            <span className="text-muted-foreground">No leave requests found for {period}</span>
          </div>
        )}

        {leavesMeta && leavesMeta.totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-4">
            <button
              onClick={() => handlePageChange(leavesFilters.page - 1)}
              disabled={leavesFilters.page <= 1}
              className="px-3 py-1 text-sm border border-border rounded-lg disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Previous
            </button>
            <span className="text-sm text-muted-foreground">
              Page {leavesFilters.page} of {leavesMeta.totalPages}
            </span>
            <button
              onClick={() => handlePageChange(leavesFilters.page + 1)}
              disabled={leavesFilters.page >= leavesMeta.totalPages}
              className="px-3 py-1 text-sm border border-border rounded-lg disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}