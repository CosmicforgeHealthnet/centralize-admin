"use client";

import React, { useRef, useEffect } from "react";
import { BadgeCheck } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import type { DoctorAppointmentGroup, AppointmentCard as AppointmentType } from "@/types/healthnet.types";

/* ─── Constants ─── */
const HOURS = Array.from({ length: 11 }, (_, i) => i + 7); // 07:00 to 17:00
const HOUR_HEIGHT = 120;
const HEADER_HEIGHT = 64;
const TIME_COL_WIDTH = 56;
const DOCTOR_COL_WIDTH = 200;

const CARD_COLORS: Record<string, { bg: string; text: string; sub: string }> = {
  pink:         { bg: "#FFF0F0", text: "#C0392B", sub: "#E57373" },
  green:        { bg: "#F0FFF4", text: "#0DA53F", sub: "#48BB78" },
  yellow:       { bg: "#FFFBEB", text: "#B7791F", sub: "#D69E2E" },
  purple:       { bg: "#F5F0FF", text: "#6D28D9", sub: "#9F7AEA" },
  blue:         { bg: "#EEF2FF", text: "#272EA7", sub: "#667EEA" },
  "solid-blue": { bg: "#272EA7", text: "#FFFFFF", sub: "#C7CAF5" },
};

function timeToHour(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h + m / 60;
}

/* ─── Appointment Card ─── */
function AppointmentCard({ appt }: { appt: AppointmentType }) {
  const c = CARD_COLORS[appt.color] ?? CARD_COLORS["solid-blue"];
  const top = (timeToHour(appt.time) - 7) * HOUR_HEIGHT;
  const height = (timeToHour(appt.timeEnd) - timeToHour(appt.time)) * HOUR_HEIGHT - 4;

  // Thresholds (px) for progressively showing detail
  const showTime  = height >= 20;
  const showCount = height >= 30;
  // Tight padding for short slots so nothing clips
  const py = height < 40 ? "4px" : "8px";

  return (
    <div
      className="absolute left-1 right-1 rounded-[8px] px-2.5 cursor-pointer"
      style={{ top, height, backgroundColor: c.bg, paddingTop: py, paddingBottom: py }}
    >
      <p
        className="text-[12px] font-poppins font-bold leading-tight truncate"
        style={{ color: c.text }}
      >
        {appt.patient}
      </p>
      {showTime && (
        <p
          className="text-[10px] font-poppins truncate"
          style={{ color: c.sub, marginTop: 2 }}
        >
          {appt.time} – {appt.timeEnd}
        </p>
      )}
      {showCount && (
        <p
          className="text-[10px] font-poppins font-medium"
          style={{ color: c.sub, marginTop: 2 }}
        >
          {appt.count}
        </p>
      )}
    </div>
  );
}

/* ─── Doctor Header ─── */
function DoctorHeader({ doctor }: { doctor: DoctorAppointmentGroup }) {
  return (
    <div className="flex items-center gap-2 px-2 py-3 border-b border-border min-w-0 h-full">
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-white text-[13px] font-poppins font-bold"
        style={{ backgroundColor: doctor.avatarBg }}
      >
        {doctor.initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-[12px] font-poppins font-semibold text-foreground truncate">
            {doctor.name}
          </span>
          <BadgeCheck className="w-3.5 h-3.5 text-primary shrink-0" />
        </div>
        <p className="text-[10px] font-poppins text-muted-foreground truncate">
          {doctor.specialty}
        </p>
      </div>
      <span
        className="text-[12px] font-poppins font-bold shrink-0"
        style={{ color: doctor.percentageColor }}
      >
        {doctor.percentage}%
      </span>
    </div>
  );
}

/* ─── Main Calendar ─── */
export default function AppointmentsCalendar() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const totalHeight = HOURS.length * HOUR_HEIGHT;

  const { appointments, appointmentsLoading, searchResults } = useHealthnetStore();
  const dateGroups = searchResults?.results ?? appointments?.appointments ?? [];
  const doctors = dateGroups.flatMap((g) => g.doctors);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [dateGroups]);

  return (
    <div className="w-full overflow-hidden">
      <div
        ref={scrollRef}
        className="overflow-auto"
        style={{ maxHeight: "calc(100vh - 320px)", minHeight: 400 }}
      >
        {/* FIX: relative + flex with no flex-1 on the row wrapper */}
        <div className="relative flex min-w-0">

          {/* Time column — sticky so it stays visible when scrolling right */}
          <div
            className="sticky left-0 shrink-0 border-r border-border z-10 bg-card"
            style={{ width: TIME_COL_WIDTH }}
          >
            <div className="border-b border-border" style={{ height: HEADER_HEIGHT }} />
            <div className="relative" style={{ height: totalHeight }}>
              {HOURS.map((hour, idx) => (
                <div
                  key={hour}
                  className="absolute left-0 right-0 flex items-start justify-end pr-2"
                  style={{ top: idx * HOUR_HEIGHT }}
                >
                  <span className="text-[10px] font-poppins text-muted-foreground -mt-3">
                    {String(hour).padStart(2, "0")}:00
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Doctor columns — overflow-x-auto handles scrolling for many doctors */}
          <div className="flex min-w-0 overflow-x-auto">
            {appointmentsLoading ? (
              <div
                className="flex items-center justify-center text-muted-foreground font-poppins text-[13px]"
                style={{ minHeight: totalHeight + HEADER_HEIGHT, minWidth: 300 }}
              >
                Loading...
              </div>
            ) : doctors.length === 0 ? (
              <div
                className="flex items-center justify-center text-muted-foreground font-poppins text-[13px]"
                style={{ minHeight: totalHeight + HEADER_HEIGHT, minWidth: 300 }}
              >
                No appointments found.
              </div>
            ) : (
              doctors.map((doctor) => (
                
                <div
                  key={`${doctor.id}-${doctor.specialty}`}
                  className="flex-1 min-w-[200px] border-r border-border last:border-r-0 flex flex-col"
                  
                >
                  <div style={{ height: HEADER_HEIGHT }}>
                    <DoctorHeader doctor={doctor} />
                  </div>

                  <div className="relative" style={{ height: totalHeight }}>
                    {/* Grid lines */}
                    {HOURS.map((_, idx) => (
                      <div
                        key={idx}
                        className="absolute left-0 right-0 border-t border-border/50"
                        style={{ top: idx * HOUR_HEIGHT }}
                      />
                    ))}
                    {/* Appointments */}
                    {doctor.appointments.map((appt) => (
                      <AppointmentCard key={appt.id} appt={appt} />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

        </div>
      </div>
    </div>
  );
}