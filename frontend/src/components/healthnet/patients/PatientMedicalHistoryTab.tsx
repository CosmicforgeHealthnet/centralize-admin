"use client";

import { useEffect } from "react";
import { FileText } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

export default function PatientMedicalHistoryTab({ patientId }: { patientId: string }) {
  const { patientMedicalHistory, patientMedicalHistoryLoading, fetchPatientMedicalHistory } = useHealthnetStore();

  useEffect(() => {
    fetchPatientMedicalHistory(patientId);
  }, [patientId, fetchPatientMedicalHistory]);

  if (patientMedicalHistoryLoading) {
    return <div className="py-10 text-center text-[13px] font-poppins text-muted-foreground animate-pulse">Loading...</div>;
  }

  if (!patientMedicalHistory || patientMedicalHistory.history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="w-16 h-16 rounded-2xl bg-primary/8 flex items-center justify-center">
          <FileText className="w-7 h-7 text-primary/50" />
        </div>
        <div className="text-center">
          <p className="text-[15px] font-poppins font-semibold text-foreground">Medical History</p>
          <p className="text-[13px] font-poppins text-muted-foreground mt-1">Patient medical history will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pb-4">
      {patientMedicalHistory.history.map((item) => (
        <div key={item.id} className="flex gap-4 p-4 rounded-[10px] border border-border bg-card shadow-[0_1px_6px_0_rgba(0,0,0,0.04)] dark:shadow-[0_1px_6px_0_rgba(0,0,0,0.2)]">
          <div className="flex flex-col items-center gap-1 shrink-0">
            <span className="text-[10px] font-poppins text-muted-foreground">{item.date ?? "—"}</span>
            <div className="w-px flex-1 bg-border" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-1">
              <span className="text-[11px] font-poppins font-semibold text-primary bg-primary/8 px-2 py-0.5 rounded-full">{item.type}</span>
            </div>
            <p className="text-[13px] font-poppins font-semibold text-foreground mt-1">{item.title ?? "—"}</p>
            {item.doctor && (
              <p className="text-[11px] font-poppins text-muted-foreground mt-0.5">
                {item.doctor}{item.department ? ` · ${item.department}` : ""}
              </p>
            )}
            {item.notes && (
              <p className="text-[11px] font-poppins text-muted-foreground mt-1 leading-relaxed">{item.notes}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}