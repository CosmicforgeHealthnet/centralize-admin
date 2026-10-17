"use client";

import React, { useState, useEffect } from "react";
import { Eye, EyeOff, Download } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";

function NoteRow({ note }: { note: { id: string; title: string; type: string; date: string; url: string } }) {
  const [visible, setVisible] = useState(false);

  const formattedDate = new Date(note.date).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  return (
    <div className="flex items-center justify-between py-4 border-b border-border last:border-0">
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-poppins font-semibold text-foreground truncate">
            {visible ? note.title : "••••••••••"}
          </span>
          <span className="text-[11px] font-poppins text-muted-foreground shrink-0">
            {visible ? `.${note.type}` : "••••"}
          </span>
        </div>
        <span className="text-[11px] font-poppins text-muted-foreground">
          {visible ? formattedDate : "••••"}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0 ml-4">
        <button
          onClick={() => setVisible((v) => !v)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {visible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
       <button
  onClick={() => window.open(note.url, "_blank")}
  className="text-muted-foreground hover:text-foreground transition-colors"
>
  <Download size={16} />
</button>
      </div>
    </div>
  );
}

export default function PerformanceTab() {
  const { profile, isLoading, fetchProfile } = useProfileStore();

  useEffect(() => {
    if (!profile) fetchProfile();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || !profile) {
    return (
      <div className="flex flex-col flex-1 min-w-0">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="flex items-center justify-between py-4 border-b border-border">
            <div className="flex flex-col gap-1.5">
              <div className="w-40 h-3 bg-muted rounded animate-pulse" />
              <div className="w-24 h-2 bg-muted rounded animate-pulse" />
            </div>
            <div className="flex gap-3">
              <div className="w-4 h-4 bg-muted rounded animate-pulse" />
              <div className="w-4 h-4 bg-muted rounded animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (profile.performanceNotes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <img src="/no_data_found.png" alt="No performance notes" className="w-[120px] h-auto object-contain" />
        <p className="text-[13px] font-poppins text-muted-foreground">No performance notes yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-w-0">
      {profile.performanceNotes.map((note) => (
        <NoteRow key={note.id} note={note} />
      ))}
    </div>
  );
}