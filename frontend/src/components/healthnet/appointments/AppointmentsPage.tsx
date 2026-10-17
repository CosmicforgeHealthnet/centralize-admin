"use client";

import React, { useEffect } from "react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import AppointmentsDateStrip from "./AppointmentsDateStrip";
import AppointmentsSearchBar from "./AppointmentsSearchBar";
import AppointmentsCalendar from "./AppointmentsCalendar";

export default function AppointmentsPage() {
  const { fetchAppointments } = useHealthnetStore();

  // Load today's appointments on first render
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    fetchAppointments({ date: today });
  }, [fetchAppointments]);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <AppointmentsSearchBar />
      <AppointmentsDateStrip />
      <AppointmentsCalendar />
    </div>
  );
}