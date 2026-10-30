"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { MapPin } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import PatientAppointmentsTab from "@/components/healthnet/patients/PatientAppointmentsTab";
import PatientMedicalHistoryTab from "@/components/healthnet/patients/PatientMedicalHistoryTab";
import PatientRecordsTab from "@/components/healthnet/patients/PatientRecordsTab";

type Tab = "appointments" | "medical-history" | "records";
const TABS: { label: string; value: Tab }[] = [
  { label: "Appointments",    value: "appointments" },
  { label: "Medical History", value: "medical-history" },
  { label: "Records",         value: "records" },
];

function StatPill({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-poppins text-muted-foreground leading-none">{label}</span>
      <span className="text-[13px] font-poppins font-semibold text-foreground leading-tight">{value ?? "—"}</span>
    </div>
  );
}

export default function PatientProfileDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>("appointments");
  const { patientDetail, patientDetailLoading, fetchPatientById } = useHealthnetStore();

  useEffect(() => {
    fetchPatientById(id);
  }, [id, fetchPatientById]);

  if (patientDetailLoading || !patientDetail) {
    return (
      <div className="flex flex-col gap-5 animate-pulse">
        <div className="h-6 bg-muted rounded w-40" />
        <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-6 h-48" />
      </div>
    );
  }

  const p = patientDetail;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[20px] font-poppins font-bold text-foreground -mt-2">Patient Profile</h1>

      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row gap-5">
          {/* Avatar + basic info */}
          <div className="flex gap-4 items-start">
            <div className="w-[90px] h-[100px] sm:w-[110px] sm:h-[120px] rounded-[12px] overflow-hidden bg-muted shrink-0">
              {p.avatarUrl ? (
                <Image src={p.avatarUrl} alt={p.name} width={110} height={120} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-secondary flex items-center justify-center">
                  <span className="text-[32px] font-bold text-primary font-poppins">{p.name.charAt(0)}</span>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1 pt-1">
              <h2 className="text-[18px] sm:text-[20px] font-poppins font-bold text-foreground leading-tight">{p.name}</h2>
              <p className="text-[12px] font-poppins text-muted-foreground">{p.email}</p>
              {p.location && (
                <div className="flex items-center gap-1 mt-1">
                  <MapPin className="w-3 h-3 text-muted-foreground" />
                  <p className="text-[12px] font-poppins text-muted-foreground">{p.location}</p>
                </div>
              )}
            </div>
          </div>

          <div className="hidden sm:block w-px bg-border mx-2 self-stretch" />

          {/* Stats grid */}
          <div className="flex-1 grid grid-cols-3 sm:grid-cols-5 gap-x-4 gap-y-4">
            <StatPill label="Sex"        value={p.sex} />
            <StatPill label="Age"        value={p.age} />
            <StatPill label="Blood Group" value={p.bloodGroup} />
            <StatPill label="Genotype"   value={p.genotype} />
            <StatPill label="Height"     value={p.height} />
            <StatPill label="Weight"     value={p.weight} />
            <div className="col-span-3 sm:col-span-5 border-t border-dashed border-border pt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatPill label="Allergies"    value={p.allergies.length > 0 ? p.allergies.join(", ") : "None"} />
              <StatPill label="Home Address" value={p.homeAddress} />
              <StatPill label="Work Address" value={p.workAddress} />
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] overflow-hidden">
        <div className="flex border-b border-border overflow-x-auto">
          {TABS.map((tab) => (
            <button 
              key={tab.value} 
              onClick={() => setActiveTab(tab.value)}
              className={`relative px-5 py-4 text-[13px] font-poppins font-medium whitespace-nowrap transition-colors shrink-0 ${
                activeTab === tab.value 
                  ? "text-primary dark:text-white" 
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {activeTab === tab.value && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary dark:bg-white rounded-t-full" />
              )}
            </button>
          ))}
        </div>
        <div className="p-5 sm:p-6">
          {activeTab === "appointments"    && <PatientAppointmentsTab   patientId={id} />}
          {activeTab === "medical-history" && <PatientMedicalHistoryTab patientId={id} />}
          {activeTab === "records"         && <PatientRecordsTab        patientId={id} />}
        </div>
      </div>
    </div>
  );
}