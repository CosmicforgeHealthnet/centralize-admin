"use client";

import { useEffect } from "react";
import { FolderOpen } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

export default function PatientRecordsTab({ patientId }: { patientId: string }) {
  const { patientRecords, patientRecordsLoading, fetchPatientRecords } = useHealthnetStore();

  useEffect(() => {
    fetchPatientRecords(patientId);
  }, [patientId, fetchPatientRecords]);

  if (patientRecordsLoading) {
    return (
      <div className="animate-pulse py-10 flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-10 bg-muted rounded" />
        ))}
      </div>
    );
  }

  if (!patientRecords?.records?.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="w-16 h-16 rounded-2xl bg-primary/8 flex items-center justify-center">
          <FolderOpen className="w-7 h-7 text-primary/50" />
        </div>
        <div className="text-center">
          <p className="text-[15px] font-poppins font-semibold text-foreground">Records</p>
          <p className="text-[13px] font-poppins text-muted-foreground mt-1">No records found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {patientRecords.records.map((record) => (
        <div key={record.id} className="flex items-center justify-between p-4 bg-muted rounded-[12px]">
          <div>
            <p className="text-[13px] font-poppins font-semibold text-foreground">{record.title ?? "Untitled"}</p>
            <p className="text-[11px] font-poppins text-muted-foreground mt-0.5">
              {record.type} · {record.uploadedBy ?? "—"} · {record.uploadedAt ?? "—"}
            </p>
          </div>
          {record.fileUrl && (
            <a 
              href={record.fileUrl} 
              target="_blank" 
              rel="noreferrer"
              className="text-[12px] font-poppins text-primary hover:underline"
            >
              View
            </a>
          )}
        </div>
      ))}
    </div>
  );
}