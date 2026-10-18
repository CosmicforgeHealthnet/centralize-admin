"use client";

import { useEffect } from "react";
import Image from "next/image";
import { Award } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

function CertCard({ title, licenseNumber, expiryDate, imageUrl, index }: {
  title: string | null; licenseNumber: string | null;
  expiryDate: string | null; imageUrl: string | null; index: number;
}) {
  return (
    <div className="flex flex-col rounded-[12px] overflow-hidden border border-border shadow-[0_1px_8px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_8px_0_rgba(0,0,0,0.2)] bg-card">
      <div className="relative w-full bg-muted overflow-hidden" style={{ aspectRatio: "16/10" }}>
        {imageUrl && (
          <Image 
            src={imageUrl} 
            alt={title ?? "Certificate"} 
            fill 
            className="object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} 
          />
        )}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-secondary to-secondary/80 z-[-1]">
          <Award className="w-10 h-10 text-primary/30" />
          <span className="text-[11px] font-poppins text-primary/40 font-medium">Certificate</span>
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-border">
        <span className="text-[10px] font-poppins text-muted-foreground shrink-0">#{index}</span>
        <span className="text-[11px] font-poppins font-semibold text-foreground flex-1 min-w-0 truncate">{title ?? "—"}</span>
        <span className="text-[10px] font-poppins text-muted-foreground shrink-0">{licenseNumber ?? "—"}</span>
        <span className="text-[10px] font-poppins text-muted-foreground shrink-0">{expiryDate ?? "—"}</span>
      </div>
    </div>
  );
}

export default function DoctorCertificationsTab({ doctorId }: { doctorId: string }) {
  const { doctorCertifications, doctorCertificationsLoading, fetchDoctorCertifications } = useHealthnetStore();

  useEffect(() => {
    fetchDoctorCertifications(doctorId);
  }, [doctorId, fetchDoctorCertifications]);

  if (doctorCertificationsLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-4 animate-pulse">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-[12px] border border-border h-40 bg-muted" />
        ))}
      </div>
    );
  }

  if (doctorCertifications.length === 0) {
    return <p className="py-10 text-center text-[13px] font-poppins text-muted-foreground">No certifications found.</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-4">
      {doctorCertifications.map((cert) => (
        <CertCard 
          key={cert.id} 
          title={cert.title} 
          licenseNumber={cert.licenseNumber}
          expiryDate={cert.expiryDate} 
          imageUrl={cert.imageUrl} 
          index={cert.index} 
        />
      ))}
    </div>
  );
}