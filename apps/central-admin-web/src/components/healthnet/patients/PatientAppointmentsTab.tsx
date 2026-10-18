"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import type { PatientTimelineAppointment } from "@/types/healthnet.types";

const TIME_SLOTS = [
  "07:00","08:00","09:00","10:00","11:00","12:00",
  "01:00","02:00","03:00","04:00","05:00","06:00","07:00",
];

function formatDisplayDate(isoDate: string) {
  const d = new Date(isoDate);
  const day = d.getUTCDate();
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  const suffix = day === 1 ? "st" : day === 2 ? "nd" : day === 3 ? "rd" : "th";
  return `${day}${suffix} ${month} ${year}`;
}

function stepDate(iso: string, days: number) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function DateNavigator({ date, onPrev, onNext }: { date: string; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-4">
      <button 
        onClick={onPrev} 
        className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-muted transition-colors"
      >
        <ChevronLeft className="w-3.5 h-3.5 text-muted-foreground" />
      </button>
      <span className="text-[12px] font-poppins font-medium text-foreground">{formatDisplayDate(date)}</span>
      <button 
        onClick={onNext} 
        className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-muted transition-colors"
      >
        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}

function AppointmentCard({ appt, variant }: { appt: PatientTimelineAppointment; variant: "upcoming" | "past" | "cancelled" }) {
  const nameColor = variant === "upcoming" 
    ? "text-[#E8A838]" 
    : variant === "past" 
      ? "text-primary" 
      : "text-muted-foreground";
  
  const bg = variant === "upcoming" 
    ? "bg-[#FFF8EC] dark:bg-[#FFF8EC]/10" 
    : variant === "past" 
      ? "bg-primary/8" 
      : "bg-muted";

  return (
    <div className={`rounded-[8px] ${bg} p-2.5 mb-2`}>
      <div className="flex items-start gap-2">
        <div className="w-7 h-7 rounded-full bg-muted overflow-hidden shrink-0">
          <Image src="/profile-img.png" alt={appt.doctorName ?? ""} width={28} height={28}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-1">
            <p className={`text-[11px] font-poppins font-semibold ${nameColor} leading-tight`}>{appt.doctorName ?? "Unknown"}</p>
            <span className="text-[9px] font-poppins text-muted-foreground shrink-0 whitespace-nowrap">{appt.date}</span>
          </div>
          <p className="text-[9px] font-poppins text-muted-foreground mt-0.5">{appt.specialty ?? "—"}</p>
        </div>
      </div>
      <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-dashed border-border">
        <span className="text-[9px] font-poppins text-muted-foreground">Appointment Booked for {appt.time}</span>
        <span className="text-[9px] font-poppins font-semibold text-muted-foreground">{appt.index} of {appt.total}</span>
      </div>
    </div>
  );
}

function TimelineColumn({ title, count, date, appointments, variant, onPrev, onNext }: {
  title: string; count: number; date: string;
  appointments: PatientTimelineAppointment[];
  variant: "upcoming" | "past" | "cancelled";
  onPrev: () => void; onNext: () => void;
}) {
  const countColor = variant === "cancelled" ? "text-muted-foreground" : "text-primary";
  const slotMap = new Map<number, PatientTimelineAppointment>();
  appointments.forEach((a) => { if (a.slotIndex !== null) slotMap.set(a.slotIndex, a); });

  return (
    <div className="w-full min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-poppins font-semibold text-foreground">{title}</h3>
        <span className={`text-[13px] font-poppins font-bold ${countColor}`}>{count}</span>
      </div>
      <DateNavigator date={date} onPrev={onPrev} onNext={onNext} />
      <div className="flex flex-col">
        {TIME_SLOTS.map((slot, idx) => {
          const appt = slotMap.get(idx);
          return (
            <div key={`${slot}-${idx}`} className={`flex gap-3 ${!appt ? "h-10" : ""}`}>
              <div className="w-10 shrink-0 pt-0.5">
                <span className="text-[10px] font-poppins text-muted-foreground">{slot}</span>
              </div>
              <div className="flex-1 border-t border-border pt-1">
                {appt && <AppointmentCard appt={appt} variant={variant} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PatientAppointmentsTab({ patientId }: { patientId: string }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const { patientTimeline, patientTimelineLoading, fetchPatientTimeline } = useHealthnetStore();

  useEffect(() => {
    fetchPatientTimeline(patientId, date);
  }, [patientId, date, fetchPatientTimeline]);

  const timeline = patientTimeline;
  const displayDate = timeline?.date ?? date;

  if (patientTimelineLoading) {
    return <div className="py-10 text-center text-[13px] font-poppins text-muted-foreground animate-pulse">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-8 md:flex-row md:gap-4 pb-4">
      <TimelineColumn title="Upcoming Appointments" count={timeline?.upcoming.length ?? 0}
        date={displayDate} appointments={timeline?.upcoming ?? []} variant="upcoming"
        onPrev={() => setDate((d) => stepDate(d, -1))} onNext={() => setDate((d) => stepDate(d, 1))} />
      <div className="hidden md:block w-px bg-border shrink-0" />
      <TimelineColumn title="Past Appointments" count={timeline?.past.length ?? 0}
        date={displayDate} appointments={timeline?.past ?? []} variant="past"
        onPrev={() => setDate((d) => stepDate(d, -1))} onNext={() => setDate((d) => stepDate(d, 1))} />
      <div className="hidden md:block w-px bg-border shrink-0" />
      <TimelineColumn title="Cancelled Appointments" count={timeline?.cancelled.length ?? 0}
        date={displayDate} appointments={timeline?.cancelled ?? []} variant="cancelled"
        onPrev={() => setDate((d) => stepDate(d, -1))} onNext={() => setDate((d) => stepDate(d, 1))} />
    </div>
  );
}