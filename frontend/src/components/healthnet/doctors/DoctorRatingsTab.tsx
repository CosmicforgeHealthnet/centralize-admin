"use client";

import { useEffect } from "react";
import Image from "next/image";
import { Star } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

function StarRow({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star 
          key={i} 
          className={`w-3 h-3 ${i < count ? "fill-[#E8A838] text-[#E8A838]" : "fill-muted text-muted"}`} 
        />
      ))}
    </div>
  );
}

export default function DoctorRatingsTab({ doctorId }: { doctorId: string }) {
  const { doctorRatings, doctorRatingsLoading, fetchDoctorRatings } = useHealthnetStore();

  useEffect(() => {
    fetchDoctorRatings(doctorId);
  }, [doctorId, fetchDoctorRatings]);

  if (doctorRatingsLoading) {
    return <div className="py-10 text-center text-[13px] font-poppins text-muted-foreground animate-pulse">Loading...</div>;
  }

  if (!doctorRatings || doctorRatings.ratings.length === 0) {
    return <p className="py-10 text-center text-[13px] font-poppins text-muted-foreground">No ratings yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3 pb-4">
      {doctorRatings.ratings.map((rating) => (
        <div key={rating.id}
          className="flex items-start gap-3 p-4 rounded-[10px] border border-border bg-card shadow-[0_1px_6px_0_rgba(0,0,0,0.04)] dark:shadow-[0_1px_6px_0_rgba(0,0,0,0.2)] hover:shadow-[0_2px_12px_0_rgba(0,0,0,0.08)] transition-shadow">
          <div className="w-9 h-9 rounded-full bg-muted overflow-hidden shrink-0">
            {rating.avatar ? (
              <Image 
                src={rating.avatar} 
                alt={`${rating.reviewerName || "Reviewer"}'s avatar`} 
                width={36} 
                height={36}
                className="w-full h-full object-cover"
                onError={(e) => {
                  const el = e.target as HTMLImageElement;
                  el.style.display = "none";
                  const p = el.parentElement;
                  if (p) {
                    p.style.background = "var(--secondary)";
                    const initial = (rating.reviewerName?.charAt(0) || "?") as string;
                    p.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--primary);font-family:Poppins">${initial}</div>`;
                  }
                }} 
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center" style={{ background: "var(--secondary)" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--primary)", fontFamily: "Poppins" }}>
                  {rating.reviewerName?.charAt(0) || "?"}
                </span>
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex flex-col gap-0.5">
                <p className="text-[12px] font-poppins font-semibold text-foreground leading-tight">{rating.reviewerName}</p>
                <StarRow count={rating.stars} />
              </div>
              <span className="text-[10px] font-poppins text-muted-foreground shrink-0 whitespace-nowrap">{rating.timeAgo}</span>
            </div>
            <p className="text-[11px] font-poppins text-muted-foreground leading-relaxed mt-1.5">{rating.comment}</p>
          </div>
        </div>
      ))}
    </div>
  );
}