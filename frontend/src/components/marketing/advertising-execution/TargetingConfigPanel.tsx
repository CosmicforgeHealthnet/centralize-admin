"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface TargetingConfigPanelProps {
  accountTimezone: string | null;
  onChange: (targeting: { locations: string[]; exclusions: string[]; scheduleNote: string }) => void;
  readOnly?: boolean;
}

export default function TargetingConfigPanel({ accountTimezone, onChange, readOnly }: TargetingConfigPanelProps) {
  const [locations, setLocations] = useState<string[]>([]);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [locationInput, setLocationInput] = useState("");
  const [exclusionInput, setExclusionInput] = useState("");
  const [scheduleNote, setScheduleNote] = useState("");

  const emit = (loc: string[], excl: string[], sched: string) => {
    onChange({ locations: loc, exclusions: excl, scheduleNote: sched });
  };

  const addLocation = () => {
    if (!locationInput.trim()) return;
    const next = [...locations, locationInput.trim()];
    setLocations(next);
    setLocationInput("");
    emit(next, exclusions, scheduleNote);
  };

  const addExclusion = () => {
    if (!exclusionInput.trim()) return;
    const next = [...exclusions, exclusionInput.trim()];
    setExclusions(next);
    setExclusionInput("");
    emit(locations, next, scheduleNote);
  };

  return (
    <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-4">
      <h3 className="font-poppins text-[12px] font-semibold text-foreground">Targeting, Placements & Scheduling</h3>

      <div className="flex flex-col gap-1.5">
        <label className="font-poppins text-[11px] font-medium text-foreground">Locations</label>
        <div className="flex flex-wrap gap-1.5">
          {locations.map((loc, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-poppins text-[11px] text-foreground">
              {loc}
              {!readOnly && (
                <button onClick={() => { const next = locations.filter((_, idx) => idx !== i); setLocations(next); emit(next, exclusions, scheduleNote); }}>
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
        {!readOnly && (
          <div className="flex gap-1.5">
            <input
              value={locationInput}
              onChange={(e) => setLocationInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addLocation()}
              placeholder="e.g. Lagos, Nigeria"
              className="flex-1 rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none"
            />
            <button onClick={addLocation} className="rounded-[6px] border border-border px-3 py-1.5 font-poppins text-[11px] text-foreground">
              Add
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="font-poppins text-[11px] font-medium text-foreground">Exclusions</label>
        <div className="flex flex-wrap gap-1.5">
          {exclusions.map((excl, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-poppins text-[11px] text-foreground">
              {excl}
              {!readOnly && (
                <button onClick={() => { const next = exclusions.filter((_, idx) => idx !== i); setExclusions(next); emit(locations, next, scheduleNote); }}>
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
        {!readOnly && (
          <div className="flex gap-1.5">
            <input
              value={exclusionInput}
              onChange={(e) => setExclusionInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addExclusion()}
              placeholder="e.g. Under 18"
              className="flex-1 rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none"
            />
            <button onClick={addExclusion} className="rounded-[6px] border border-border px-3 py-1.5 font-poppins text-[11px] text-foreground">
              Add
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className="font-poppins text-[11px] font-medium text-foreground">Schedule</label>
        <input
          value={scheduleNote}
          disabled={readOnly}
          onChange={(e) => { setScheduleNote(e.target.value); emit(locations, exclusions, e.target.value); }}
          placeholder="e.g. Mon-Fri 8am-8pm"
          className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none disabled:opacity-60"
        />
        <span className="font-poppins text-[10px] text-muted-foreground">
          Account timezone: {accountTimezone ?? "Not resolved"} — schedules are stored and executed in UTC.
        </span>
      </div>

      <p className="font-poppins text-[10px] text-muted-foreground">
        No audience PII, CRM lists, or regulated-category targeting (political, housing, employment, credit,
        healthcare) is supported in this release.
      </p>
    </div>
  );
}