"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ArrowLeft, ChevronDown, CreditCard, Phone, Mail, Calendar, Briefcase, MapPin, Users, BarChart3, CalendarX } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useHrmStore } from "@/stores/hrm.store";
import { attendanceService } from "@/lib/hrm.service";
import { AttendanceStatus, AttendancePeriod } from "@/types/hrm.types";

const STATUS_STYLES: Record<AttendanceStatus, { bg: string; text: string; label: string }> = {
  PRESENT: { bg: "rgba(13,165,63,0.12)", text: "#0DA53F", label: "Present" },
  LATE:    { bg: "rgba(232,182,0,0.12)", text: "#E8B600", label: "Late" },
  ABSENT:  { bg: "rgba(246,69,69,0.12)", text: "#F64545", label: "Absent" },
};

const PERIOD_OPTIONS: AttendancePeriod[] = ["This Week", "Last Week", "This Month"];

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
      <p className="font-poppins text-[11px] text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.fill }} />
          <span className="font-poppins text-[11px] text-foreground">{p.name}: {p.value}</span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  employeeId: string;
  onBack: () => void;
}

export default function AttendanceDetail({ employeeId, onBack }: Props) {
  const [period, setPeriod] = useState<AttendancePeriod>("This Week");
  const [downloading, setDownloading] = useState(false);

  const {
    selectedAttendanceOverview: selectedOverview, isLoadingAttendanceOverview: isLoadingOverview,
    fetchEmployeeAttendanceOverview: fetchEmployeeOverview,
    attendanceLogs: logs, isLoadingAttendanceLogs: isLoadingLogs,
    fetchEmployeeAttendanceLogs: fetchEmployeeLogs,
    clearSelectedAttendanceEmployee: clearSelectedEmployee,
  } = useHrmStore();

  useEffect(() => {
    fetchEmployeeOverview(employeeId);
    return () => clearSelectedEmployee();
  }, [employeeId, fetchEmployeeOverview, clearSelectedEmployee]);

  useEffect(() => {
    fetchEmployeeLogs(employeeId, period);
  }, [employeeId, period, fetchEmployeeLogs]);

  async function handleDownload() {
    setDownloading(true);
    try {
      const blob = await attendanceService.downloadReport({ employeeId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "attendance-report.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  if (isLoadingOverview || !selectedOverview) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-4 w-40 bg-muted rounded animate-pulse" />
        <div className="h-[300px] bg-muted rounded-xl animate-pulse" />
      </div>
    );
  }

  const emp = selectedOverview.employee;

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">Attendance</span>
        </button>
        <span className="text-muted-foreground text-[12px]">/</span>
        <span className="font-poppins text-[12px] font-medium text-primary">Employee Attendance Details</span>
      </div>

      <h2 className="font-poppins text-[14px] font-semibold text-foreground">Employee Attendance</h2>

      {/* Main layout */}
      <div className="flex flex-col md:flex-row gap-4 items-start">
        {/* Left: charts + log */}
        <div className="flex-1 min-w-0 w-full flex flex-col gap-4">

          {/* Profile Details card */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-poppins text-[13px] font-semibold text-foreground">Profile Details</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-3">
              {[
                { label: "Full Name:",           value: emp.name },
                { label: "Department:",          value: emp.department ?? "-" },
                { label: "Employment Type:",     value: emp.employmentType ?? "-" },
                { label: "Employment Category:", value: emp.employmentCategory ?? "-" },
                { label: "Employment Date:",     value: emp.employmentDate },
              ].map(({ label, value }) => (
                <div key={label} className="flex flex-col gap-0.5">
                  <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
                  <span className="font-poppins text-[12px] font-semibold text-foreground">{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Attendance Overview Chart */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-1">
              <div>
                <h3 className="font-poppins text-[13px] font-semibold text-foreground">
                  Employee Attendance Overview
                </h3>
                <p className="font-poppins text-[11px] text-muted-foreground">January-Till date</p>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-sm bg-[#0DA53F]" />
                    <span className="font-poppins text-[11px] text-muted-foreground">Present</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-sm bg-[#E8B600]" />
                    <span className="font-poppins text-[11px] text-muted-foreground">Late</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-sm bg-[#F64545]" />
                    <span className="font-poppins text-[11px] text-muted-foreground">Absent</span>
                  </div>
                </div>
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0 disabled:opacity-60"
                >
                  {downloading ? "Downloading..." : "Download Report"}
                  <ChevronDown className="w-3 h-3" />
                </button>
              </div>
            </div>

            {selectedOverview.chartData.every((d) => d.present === 0 && d.late === 0 && d.absent === 0) ? (
              <div className="h-[220px] flex flex-col items-center justify-center gap-2">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                  <BarChart3 className="w-5 h-5 text-muted-foreground" />
                </div>
                <p className="font-poppins text-[12px] font-semibold text-foreground">No attendance data yet</p>
                <p className="font-poppins text-[11px] text-muted-foreground">
                  This employee has no recorded attendance for the year.
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={selectedOverview.chartData} barSize={10} barGap={2} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(39,46,167,0.04)" }} />
                  <Bar dataKey="present" name="Present" fill="#0DA53F" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="late" name="Late" fill="#E8B600" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="absent" name="Absent" fill="#F64545" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Attendance Log Table */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div>
                <h3 className="font-poppins text-[13px] font-semibold text-foreground">Employee Attendance</h3>
                <p className="font-poppins text-[11px] text-muted-foreground">Employee Attendance Monitoring</p>
              </div>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value as AttendancePeriod)}
                className="text-[11px] font-poppins text-muted-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer"
              >
                {PERIOD_OPTIONS.map((o) => <option key={o}>{o}</option>)}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[500px]">
                <tbody>
                  {isLoadingLogs ? (
                    Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i} className="border-b border-border/50">
                        {Array.from({ length: 5 }).map((__, j) => (
                          <td key={j} className="py-3 px-4">
                            <div className="h-4 bg-muted rounded animate-pulse w-full max-w-[80px]" />
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : logs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-10">
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                            <CalendarX className="w-4.5 h-4.5 text-muted-foreground" />
                          </div>
                          <p className="font-poppins text-[12px] font-semibold text-foreground">
                            No attendance logs
                          </p>
                          <p className="font-poppins text-[11px] text-muted-foreground">
                            Nothing recorded for {period.toLowerCase()}.
                          </p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    logs.map((log) => {
                      const st = STATUS_STYLES[log.status] ?? STATUS_STYLES.PRESENT;
                      return (
                        <tr key={log.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                          <td className="py-3 px-4 font-poppins text-[12px] text-foreground w-[140px]">{log.date}</td>
                          <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{log.clockIn ?? "-"}</td>
                          <td className="py-3 px-4 font-poppins text-[12px] text-foreground">{log.clockOut ?? "-"}</td>
                          <td className="py-3 px-4">
                            <span
                              className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-poppins font-semibold whitespace-nowrap"
                              style={{ backgroundColor: st.bg, color: st.text }}
                            >
                              {st.label}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <button className="text-muted-foreground hover:text-foreground transition-colors">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
                              </svg>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right panel — basic quick info, populated from overview employee */}
        <div className="flex flex-col gap-3 w-full md:w-[175px] md:shrink-0">
          <div className="w-full md:w-[175px] md:h-[180px] h-[140px] rounded-xl overflow-hidden bg-muted flex items-center justify-center">
            <div className="w-full h-full bg-primary/10 flex items-center justify-center">
              <span className="text-[40px] font-poppins font-bold text-primary">{emp.name.charAt(0)}</span>
            </div>
          </div>

          <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2.5">
            {[
              { icon: <Calendar    className="w-3.5 h-3.5" />, label: "Employment Date:",     value: emp.employmentDate },
              { icon: <Briefcase   className="w-3.5 h-3.5" />, label: "Employment Type:",      value: emp.employmentType ?? "-" },
              { icon: <MapPin      className="w-3.5 h-3.5" />, label: "Employment Category:",  value: emp.employmentCategory ?? "-" },
              { icon: <Users       className="w-3.5 h-3.5" />, label: "Department:",           value: emp.department ?? "-" },
            ].map(({ icon, label, value }) => (
              <div key={label} className="flex items-start gap-2">
                <span className="text-muted-foreground shrink-0 mt-0.5">{icon}</span>
                <div className="flex flex-col min-w-0">
                  <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
                  <span className="font-poppins text-[11px] font-semibold text-foreground break-words">{value}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}