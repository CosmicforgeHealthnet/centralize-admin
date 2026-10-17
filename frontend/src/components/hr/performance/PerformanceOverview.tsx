"use client";
import type { AdminChartTooltipProps } from "@/types/chart-tooltip.types";

import { useEffect, useState } from "react";
import Image from "next/image";
import { TrendingUp, TrendingDown, Search, ChevronDown } from "lucide-react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { useHrmStore } from "@/stores/hrm.store";
import { PerformanceFilterBy, PerformanceTask, PerformanceTeam, PerformanceProject, PerformanceEmployee } from "@/types/hrm.types";

function StatIcon({ type, color }: { type: string; color: string }) {
  const cls = `w-5 h-5`;
  const style = { color };
  if (type === "employees") return (
    <svg className={cls} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
  if (type === "teams") return (
    <svg className={cls} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
  if (type === "tasks") return (
    <svg className={cls} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 11 12 14 22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  );
  if (type === "projects") return (
    <svg className={cls} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  );
  return (
    <svg className={cls} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}

function StatCard({ 
  label, 
  value, 
  change, 
  trend, 
  subtitle, 
  color, 
  icon,
  isLoading 
}: { 
  label: string;
  value: string | number;
  change: string;
  trend: "up" | "down";
  subtitle: string;
  color: string;
  icon: string;
  isLoading: boolean;
}) {
  const isUp = trend === "up";
  const displayValue = isLoading ? "..." : value;
  
  return (
    <div className="bg-card rounded-xl border border-border p-3 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col gap-1">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mb-1" style={{ backgroundColor: `${color}18` }}>
        <StatIcon type={icon} color={color} />
      </div>
      <span className="font-poppins text-[11px] font-semibold truncate" style={{ color }}>{label}</span>
      <span className="font-poppins text-[24px] font-bold text-foreground leading-none">{displayValue}</span>
      <div className="flex items-center gap-1 flex-wrap">
        {isUp
          ? <TrendingUp className="w-3 h-3 text-green-500 shrink-0" />
          : <TrendingDown className="w-3 h-3 text-red-500 shrink-0" />
        }
        <span className={`font-poppins text-[10px] font-semibold ${isUp ? "text-green-500" : "text-red-500"}`}>{change}</span>
        <span className="font-poppins text-[10px] text-muted-foreground">{subtitle}</span>
      </div>
    </div>
  );
}

function PerformanceScore() {
  const { performanceScore, isLoadingPerformanceScore } = useHrmStore();
  const score = performanceScore?.score || 0;
  
  const r = 60;
  const cx = 80;
  const cy = 80;
  const startAngle = -210;
  const endAngle = 30;
  const totalAngle = endAngle - startAngle;
  const scoreAngle = startAngle + (score / 100) * totalAngle;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const arcPath = (start: number, end: number, color: string) => {
    const x1 = cx + r * Math.cos(toRad(start));
    const y1 = cy + r * Math.sin(toRad(start));
    const x2 = cx + r * Math.cos(toRad(end));
    const y2 = cy + r * Math.sin(toRad(end));
    const large = end - start > 180 ? 1 : 0;
    return <path d={`M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`} stroke={color} strokeWidth="12" fill="none" strokeLinecap="round" />;
  };

  const needleX = cx + (r - 8) * Math.cos(toRad(scoreAngle));
  const needleY = cy + (r - 8) * Math.sin(toRad(scoreAngle));

  const bars = performanceScore?.bars || [
    { label: "Project Timeline", value: 0, color: "#F59E0B" },
    { label: "Execution", value: 0, color: "#0DA53F" },
    { label: "Attendance", value: 0, color: "#0DA53F" },
  ];

  const upcomingEvent = performanceScore?.upcomingEvent;

  return (
    <div className="bg-card rounded-xl border border-border p-4 flex flex-col lg:flex-row gap-4">
      <div className="flex flex-col items-center shrink-0">
        <p className="font-poppins text-[12px] font-semibold text-foreground mb-2 self-start">Performance Score</p>
        {isLoadingPerformanceScore ? (
          <div className="w-[160px] h-[110px] flex items-center justify-center">
            <span className="text-muted-foreground">Loading...</span>
          </div>
        ) : (
          <svg width="160" height="110" viewBox="0 0 160 110">
            {arcPath(-210, 30, "#f1f5f9")}
            {arcPath(-210, -150, "#F64545")}
            {arcPath(-150, -60, "#F59E0B")}
            {arcPath(-60, 30, "#0DA53F")}
            <line x1={cx} y1={cy} x2={needleX} y2={needleY} stroke="#1e293b" strokeWidth="3" strokeLinecap="round" />
            <circle cx={cx} cy={cy} r="5" fill="#1e293b" />
            <text x={cx} y={cy + 20} textAnchor="middle" fontSize="13" fontWeight="700" fill="#272EA7" fontFamily="Poppins">
              {score}%
            </text>
            <text x={cx} y={cy + 34} textAnchor="middle" fontSize="9" fill="#94a3b8" fontFamily="Poppins">
              This Week
            </text>
          </svg>
        )}
      </div>

      <div className="flex flex-col gap-3 flex-1 justify-center">
        {bars.map((bar) => (
          <div key={bar.label} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="font-poppins text-[11px] text-foreground">{bar.label}</span>
              <span className="font-poppins text-[11px] font-semibold text-foreground">{bar.value}%</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${bar.value}%`, backgroundColor: bar.color }} />
            </div>
          </div>
        ))}
        <div className="flex items-center gap-4 mt-1 flex-wrap">
          {[
            { label: "Excellent", color: "#0DA53F" },
            { label: "Intermediate", color: "#F59E0B" },
            { label: "Poor", color: "#F64545" },
          ].map((l) => (
            <div key={l.label} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: l.color }} />
              <span className="font-poppins text-[11px] text-muted-foreground">{l.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 bg-muted/50 rounded-xl border border-border p-4 flex flex-col gap-1 min-w-[180px]">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          </span>
          <span className="font-poppins text-[11px] font-semibold text-primary">Upcoming Event</span>
        </div>
        {isLoadingPerformanceScore ? (
          <span className="font-poppins text-[28px] font-bold text-primary leading-none">Loading...</span>
        ) : upcomingEvent ? (
          <>
            <span className="font-poppins text-[28px] font-bold text-primary leading-none">02:00:12</span>
            <div className="flex flex-col gap-0.5 mt-1">
              <span className="font-poppins text-[11px] text-foreground">Event: {upcomingEvent.title}</span>
              <span className="font-poppins text-[11px] text-muted-foreground">Date: {upcomingEvent.date}</span>
              <span className="font-poppins text-[11px] text-muted-foreground">Time: {upcomingEvent.time}</span>
            </div>
          </>
        ) : (
          <span className="font-poppins text-[11px] text-muted-foreground">No upcoming events</span>
        )}
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label }: AdminChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
      <p className="font-poppins text-[11px] text-muted-foreground mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
          <span className="font-poppins text-[11px] text-foreground">{p.name}: {p.value}%</span>
        </div>
      ))}
    </div>
  );
}

function DepartmentalChart() {
  const { performanceChart, isLoadingPerformanceChart } = useHrmStore();
  const data = performanceChart.length > 0 ? performanceChart : [];

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Departmental Performance</h3>
          <p className="font-poppins text-[11px] text-muted-foreground">Department Performance and Report</p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {[
            { label: "Marketing", color: "rgba(39,46,167,0.25)" },
            { label: "Development", color: "#F64545" },
            { label: "Social Media", color: "#272EA7" },
          ].map((l) => (
            <div key={l.label} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: l.color }} />
              <span className="font-poppins text-[11px] text-muted-foreground">{l.label}</span>
            </div>
          ))}
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0">
            Download Report <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      </div>
      {isLoadingPerformanceChart ? (
        <div className="h-[260px] flex items-center justify-center">
          <span className="text-muted-foreground">Loading chart...</span>
        </div>
      ) : data.length > 0 ? (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="marketing" name="Marketing" barSize={18} radius={[4, 4, 0, 0]} fill="rgba(39,46,167,0.20)" />
            <Bar dataKey="development" name="Development" barSize={18} radius={[4, 4, 0, 0]} fill="#272EA7" />
            <Line type="monotone" dataKey="socialMedia" name="Social Media" stroke="#F64545" strokeWidth={2} dot={{ r: 4, fill: "#F64545", strokeWidth: 0 }} activeDot={{ r: 5 }} />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-[260px] flex items-center justify-center">
          <span className="text-muted-foreground">No chart data available</span>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; text: string }> = {
    "COMPLETED": { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
    "IN_PROGRESS": { bg: "rgba(39,46,167,0.10)", text: "#272EA7" },
    "OVERDUE": { bg: "rgba(246,69,69,0.12)", text: "#F64545" },
    "In Progress": { bg: "rgba(39,46,167,0.10)", text: "#272EA7" },
    "Completed": { bg: "rgba(13,165,63,0.12)", text: "#0DA53F" },
    "Overdue": { bg: "rgba(246,69,69,0.12)", text: "#F64545" },
  };
  const st = styles[status] || styles["IN_PROGRESS"] || { bg: "rgba(39,46,167,0.10)", text: "#272EA7" };
  const displayStatus = status?.replace("_", " ") || "In Progress";
  
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap"
      style={{ backgroundColor: st.bg, color: st.text }}>
      {displayStatus}
    </span>
  );
}

function DotsMenu() {
  return (
    <button className="text-muted-foreground hover:text-foreground transition-colors">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
      </svg>
    </button>
  );
}

function TaskTable({ data, title, subtitle, isLoading }: { 
  data: PerformanceTask[]; 
  title: string; 
  subtitle: string;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
          <p className="font-poppins text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center justify-center h-40">
          <span className="text-muted-foreground">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
        <p className="font-poppins text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[750px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {["Employee Name", "Employee ID", "Department", "Tasks", "Assigned Date", "Due Date", "Status", "Action"].map((h) => (
                <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length > 0 ? data.map((row, i) => (
              <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
                <td className="py-3 px-4">
                  <div className="flex flex-col min-w-0">
                    <span className="font-poppins text-[12px] font-semibold text-foreground truncate">{row.assignee.name || 'Unknown'}</span>
                    <span className="font-poppins text-[10px] text-muted-foreground truncate">{row.assignee.email || ''}</span>
                  </div>
                </td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.assignee.employeeCode || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.assignee.department || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.title}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.assignedDate || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.dueDate || 'N/A'}</td>
                <td className="py-3 px-4"><StatusBadge status={row.status} /></td>
                <td className="py-3 px-4"><DotsMenu /></td>
              </tr>
            )) : (
              <tr>
                <td colSpan={8} className="py-8 text-center text-muted-foreground">No tasks found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeamTable({ data, title, subtitle, isLoading }: { 
  data: PerformanceTeam[]; 
  title: string; 
  subtitle: string;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
          <p className="font-poppins text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center justify-center h-40">
          <span className="text-muted-foreground">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
        <p className="font-poppins text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[750px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {["Project Title", "Assigned Date", "Due Date", "Team", "Team Lead", "Members", "Status", "Action"].map((h) => (
                <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length > 0 ? data.map((row, i) => (
              <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
                <td className="py-3 px-4 font-poppins text-[12px] font-semibold text-foreground whitespace-nowrap">{row.projectTitle}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.assignedDate || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.dueDate || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.team || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.teamLead || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.members}</td>
                <td className="py-3 px-4"><StatusBadge status={row.status} /></td>
                <td className="py-3 px-4"><DotsMenu /></td>
              </tr>
            )) : (
              <tr>
                <td colSpan={8} className="py-8 text-center text-muted-foreground">No teams found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProjectTable({ data, title, subtitle, isLoading }: { 
  data: PerformanceProject[]; 
  title: string; 
  subtitle: string;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
          <p className="font-poppins text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center justify-center h-40">
          <span className="text-muted-foreground">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
        <p className="font-poppins text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[750px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {["Project Title", "Assigned Date", "Due Date", "Team", "Team Lead", "Members", "Status", "Action"].map((h) => (
                <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length > 0 ? data.map((row, i) => (
              <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
                <td className="py-3 px-4 font-poppins text-[12px] font-semibold text-foreground whitespace-nowrap">{row.title}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.assignedDate || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.dueDate || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.team || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.teamLead || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.members}</td>
                <td className="py-3 px-4"><StatusBadge status={row.status} /></td>
                <td className="py-3 px-4"><DotsMenu /></td>
              </tr>
            )) : (
              <tr>
                <td colSpan={8} className="py-8 text-center text-muted-foreground">No projects found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmployeeTable({ data, title, subtitle, isLoading }: { 
  data: PerformanceEmployee[]; 
  title: string; 
  subtitle: string;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
          <p className="font-poppins text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center justify-center h-40">
          <span className="text-muted-foreground">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
        <p className="font-poppins text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[750px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {["Employee Name", "Employee ID", "Department", "Tasks", "Assigned Date", "Due Date", "Status", "Action"].map((h) => (
                <th key={h} className="text-left py-2.5 px-4 text-[11px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length > 0 ? data.map((row, i) => (
              <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
                <td className="py-3 px-4">
                  <div className="flex flex-col min-w-0">
                    <span className="font-poppins text-[12px] font-semibold text-foreground truncate">{row.name}</span>
                    <span className="font-poppins text-[10px] text-muted-foreground truncate">{row.email}</span>
                  </div>
                </td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.employeeCode || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.department || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.task || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.assignedDate || 'N/A'}</td>
                <td className="py-3 px-4 font-poppins text-[12px] text-foreground whitespace-nowrap">{row.dueDate || 'N/A'}</td>
                <td className="py-3 px-4">{row.status ? <StatusBadge status={row.status} /> : 'N/A'}</td>
                <td className="py-3 px-4"><DotsMenu /></td>
              </tr>
            )) : (
              <tr>
                <td colSpan={8} className="py-8 text-center text-muted-foreground">No employees found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterSection({ filterBy, onFilterByChange }: { filterBy: PerformanceFilterBy; onFilterByChange: (f: PerformanceFilterBy) => void }) {
  const [search, setSearch] = useState("");
  const { 
    performanceTasks, 
    performanceTasksMeta,
    isLoadingPerformanceTasks,
    performanceTasksFilters,
    fetchPerformanceTasks,
    setPerformanceTasksFilters,

    performanceTeams,
    performanceTeamsMeta,
    isLoadingPerformanceTeams,
    performanceTeamsFilters,
    fetchPerformanceTeams,
    setPerformanceTeamsFilters,

    performanceProjects,
    performanceProjectsMeta,
    isLoadingPerformanceProjects,
    performanceProjectsFilters,
    fetchPerformanceProjects,
    setPerformanceProjectsFilters,

    performanceEmployees,
    performanceEmployeesMeta,
    isLoadingPerformanceEmployees,
    performanceEmployeesFilters,
    fetchPerformanceEmployees,
    setPerformanceEmployeesFilters,
  } = useHrmStore();

  const handleFilter = () => {
    const params = { search: search || undefined };
    
    switch (filterBy) {
      case "Task":
        setPerformanceTasksFilters({ ...params, page: 1 });
        break;
      case "Team":
        setPerformanceTeamsFilters({ ...params, page: 1 });
        break;
      case "Project":
        setPerformanceProjectsFilters({ ...params, page: 1 });
        break;
      case "Employee":
        setPerformanceEmployeesFilters({ ...params, page: 1 });
        break;
    }
  };

  const handlePageChange = (page: number) => {
    switch (filterBy) {
      case "Task":
        setPerformanceTasksFilters({ ...performanceTasksFilters, page });
        break;
      case "Team":
        setPerformanceTeamsFilters({ ...performanceTeamsFilters, page });
        break;
      case "Project":
        setPerformanceProjectsFilters({ ...performanceProjectsFilters, page });
        break;
      case "Employee":
        setPerformanceEmployeesFilters({ ...performanceEmployeesFilters, page });
        break;
    }
  };

  const getCurrentData = () => {
    switch (filterBy) {
      case "Task":
        return { data: performanceTasks, meta: performanceTasksMeta, isLoading: isLoadingPerformanceTasks };
      case "Team":
        return { data: performanceTeams, meta: performanceTeamsMeta, isLoading: isLoadingPerformanceTeams };
      case "Project":
        return { data: performanceProjects, meta: performanceProjectsMeta, isLoading: isLoadingPerformanceProjects };
      case "Employee":
        return { data: performanceEmployees, meta: performanceEmployeesMeta, isLoading: isLoadingPerformanceEmployees };
    }
  };

  const current = getCurrentData();

  const renderTable = () => {
    switch (filterBy) {
      case "Task":
        return <TaskTable data={performanceTasks} title="Task Performance" subtitle="Task Performance & Management" isLoading={isLoadingPerformanceTasks} />;
      case "Team":
        return <TeamTable data={performanceTeams} title="Team Performance" subtitle="Team Performance & Task Management" isLoading={isLoadingPerformanceTeams} />;
      case "Project":
        return <ProjectTable data={performanceProjects} title="Project Performance" subtitle="Project Performance & Task Management" isLoading={isLoadingPerformanceProjects} />;
      case "Employee":
        return <EmployeeTable data={performanceEmployees} title="Employee Performance" subtitle="Employee Performance & Task Management" isLoading={isLoadingPerformanceEmployees} />;
    }
  };

  const FILTER_OPTIONS: PerformanceFilterBy[] = ["Task", "Team", "Project", "Employee"];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="font-poppins text-[12px] text-foreground shrink-0">Filter By:</span>
          <select
            value={filterBy}
            onChange={(e) => onFilterByChange(e.target.value as PerformanceFilterBy)}
            className="text-[12px] font-poppins text-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer h-[36px]"
          >
            {FILTER_OPTIONS.map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search here..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleFilter()}
            className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
          />
        </div>
        <button
          onClick={handleFilter}
          className="h-[36px] px-6 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
        >
          Filter
        </button>
      </div>

      <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
        {renderTable()}

        {current.meta && current.meta.totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-2">
            <button
              onClick={() => handlePageChange(current.meta!.page - 1)}
              disabled={current.meta!.page <= 1}
              className="px-3 py-1 text-sm border border-border rounded-lg disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Previous
            </button>
            <span className="text-sm text-muted-foreground">
              Page {current.meta!.page} of {current.meta!.totalPages}
            </span>
            <button
              onClick={() => handlePageChange(current.meta!.page + 1)}
              disabled={current.meta!.page >= current.meta!.totalPages}
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

export default function PerformanceOverview() {
  const [filterBy, setFilterBy] = useState<PerformanceFilterBy>("Task");
  const {
    performanceStats,
    isLoadingPerformanceStats,
    performanceError,
    fetchPerformanceStats,
    fetchPerformanceScore,
    fetchPerformanceChart,
    fetchPerformanceTasks,
    fetchPerformanceTeams,
    fetchPerformanceProjects,
    fetchPerformanceEmployees,
  } = useHrmStore();

  useEffect(() => {
    fetchPerformanceStats();
    fetchPerformanceScore();
    fetchPerformanceChart();
    fetchPerformanceTasks();
    fetchPerformanceTeams();
    fetchPerformanceProjects();
    fetchPerformanceEmployees();
  }, []);

  const stats = performanceStats;
  const statCards = [
    { 
      label: "Total Employees", 
      value: stats?.totalEmployees || 0, 
      change: `${stats?.changes?.employeesChange || 0}%`, 
      trend: (stats?.changes?.employeesChange || 0) >= 0 ? "up" as const : "down" as const, 
      subtitle: "performance from last week", 
      color: "#272EA7", 
      icon: "employees" 
    },
    { 
      label: "Teams", 
      value: stats?.totalTeams || 0, 
      change: `${stats?.changes?.teamsChange || 0}%`, 
      trend: (stats?.changes?.teamsChange || 0) >= 0 ? "up" as const : "down" as const, 
      subtitle: "performance from last week", 
      color: "#0DA53F", 
      icon: "teams" 
    },
    { 
      label: "Tasks", 
      value: stats?.totalTasks || 0, 
      change: `${stats?.changes?.tasksChange || 0}%`, 
      trend: (stats?.changes?.tasksChange || 0) >= 0 ? "up" as const : "down" as const, 
      subtitle: "performance from last week", 
      color: "#F64545", 
      icon: "tasks" 
    },
    { 
      label: "Projects", 
      value: stats?.totalProjects || 0, 
      change: `${stats?.changes?.projectsChange || 0}%`, 
      trend: (stats?.changes?.projectsChange || 0) >= 0 ? "up" as const : "down" as const, 
      subtitle: "consistent with last week", 
      color: "#F59E0B", 
      icon: "projects" 
    },
    { 
      label: "Events", 
      value: stats?.totalEvents || 0, 
      change: `${stats?.changes?.eventsChange || 0}%`, 
      trend: (stats?.changes?.eventsChange || 0) >= 0 ? "up" as const : "down" as const, 
      subtitle: "consistent with last week", 
      color: "#8B5CF6", 
      icon: "events" 
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {performanceError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {performanceError}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {statCards.map((card) => (
          <StatCard
            key={card.label}
            label={card.label}
            value={card.value}
            change={card.change}
            trend={card.trend}
            subtitle={card.subtitle}
            color={card.color}
            icon={card.icon}
            isLoading={isLoadingPerformanceStats}
          />
        ))}
      </div>

      <PerformanceScore />
      <DepartmentalChart />
      <FilterSection filterBy={filterBy} onFilterByChange={setFilterBy} />
    </div>
  );
}