"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { MapPin, Mail, Phone, Star, Calendar, Clock } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import DoctorAppointmentsTab from "@/components/healthnet/doctors/DoctorAppointmentsTab";
import DoctorCertificationsTab from "@/components/healthnet/doctors/DoctorCertificationsTab";
import DoctorRatingsTab from "@/components/healthnet/doctors/DoctorRatingsTab";

type Tab = "appointments" | "certifications" | "ratings";
const TABS: { label: string; value: Tab }[] = [
  { label: "Appointments", value: "appointments" },
  { label: "Certifications", value: "certifications" },
  { label: "Ratings", value: "ratings" },
];

export default function DoctorProfileDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>("appointments");
  const { doctorDetail, doctorDetailLoading, fetchDoctorById } = useHealthnetStore();

  useEffect(() => {
    fetchDoctorById(id);
  }, [id, fetchDoctorById]);

  if (doctorDetailLoading || !doctorDetail) {
    return (
      <div className="flex flex-col gap-5 animate-pulse">
        <div className="h-6 bg-muted rounded w-40" />
        <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-6 h-60" />
      </div>
    );
  }

  const d = doctorDetail;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[20px] font-poppins font-bold text-foreground -mt-2">Doctor Profile</h1>

      {/* Profile card */}
      <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5 sm:p-6">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col sm:flex-row gap-5">
            {/* Avatar + basic info */}
            <div className="flex gap-4 items-start">
              <div className="w-[90px] h-[100px] sm:w-[110px] sm:h-[120px] rounded-[12px] overflow-hidden bg-muted shrink-0">
                {d.avatarUrl ? (
                  <Image src={d.avatarUrl} alt={d.name} width={110} height={120} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-secondary flex items-center justify-center">
                    <span className="text-[28px] font-bold text-primary font-poppins">{d.name.replace("Dr ", "").charAt(0)}</span>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5 pt-1">
                <h2 className="text-[18px] sm:text-[20px] font-poppins font-bold text-foreground leading-tight">{d.name}</h2>
                <div className="flex items-center gap-1.5">
                  <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
                  <p className="text-[12px] font-poppins text-muted-foreground">{d.hospital ?? d.location ?? "—"}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Mail className="w-3 h-3 text-muted-foreground shrink-0" />
                  <p className="text-[12px] font-poppins text-muted-foreground">{d.email}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Phone className="w-3 h-3 text-muted-foreground shrink-0" />
                  <p className="text-[12px] font-poppins text-muted-foreground">{d.phone ?? "—"}</p>
                </div>
              </div>
            </div>

            <div className="hidden sm:block w-px bg-border mx-2 self-stretch" />

            {/* Stats */}
            <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
              {[
                { label: "Department", value: d.department ?? "—" },
                { label: "Patients",   value: d.patients },
                { label: "Experience", value: d.experience ? `${d.experience} yrs` : "—" },
                { label: "Ratings",    value: d.rating, isRating: true },
                { label: "Location",   value: d.location ?? "—" },
                { label: "Address",    value: d.address ?? "—" },
              ].map(({ label, value, isRating }) => (
                <div key={label} className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-poppins text-muted-foreground">{label}</span>
                  {isRating ? (
                    <div className="flex items-center gap-1">
                      <Star className="w-3.5 h-3.5 fill-[#E8A838] text-[#E8A838]" />
                      <span className="text-[13px] font-poppins font-semibold text-foreground">{value}</span>
                    </div>
                  ) : (
                    <span className="text-[13px] font-poppins font-semibold text-foreground leading-snug">{value}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border" />

          {/* Bio */}
          <div>
            <p className="text-[13px] font-poppins font-semibold text-foreground mb-1.5">Bio</p>
            <p className="text-[12px] font-poppins text-muted-foreground leading-relaxed">{d.bio ?? "No bio available."}</p>
          </div>

          {/* Working Hours */}
          <div>
            <p className="text-[13px] font-poppins font-semibold text-foreground mb-2">Working Hours</p>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-[12px] font-poppins text-muted-foreground">
                  {d.workingDays?.length > 0 ? d.workingDays.join(", ") : "—"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-[12px] font-poppins text-muted-foreground">{d.workingHours ?? "—"}</span>
              </div>
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
          {activeTab === "appointments"   && <DoctorAppointmentsTab   doctorId={id} />}
          {activeTab === "certifications" && <DoctorCertificationsTab doctorId={id} />}
          {activeTab === "ratings"        && <DoctorRatingsTab        doctorId={id} />}
        </div>
      </div>
    </div>
  );
}