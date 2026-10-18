"use client";

import StatusChip from "./StatusChip";

export interface TimelineEntry {
  id: string;
  label: string;
  status?: string;
  timestamp: string | null;
  detail?: string;
}

interface TimelineProps {
  entries: TimelineEntry[];
  emptyLabel?: string;
}

export default function Timeline({ entries, emptyLabel }: TimelineProps) {
  if (entries.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-sm py-4 font-poppins">
        {emptyLabel ?? "No history yet"}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {entries.map((entry, i) => (
        <div key={entry.id} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
            {i < entries.length - 1 && <div className="w-px flex-1 bg-border" />}
          </div>
          <div className="flex flex-col gap-0.5 pb-4 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-poppins text-[12px] font-medium text-foreground">{entry.label}</span>
              {entry.status && <StatusChip status={entry.status} />}
            </div>
            {entry.detail && (
              <span className="font-poppins text-[11px] text-muted-foreground">{entry.detail}</span>
            )}
            {entry.timestamp && (
              <span className="font-poppins text-[10px] text-muted-foreground">
                {new Date(entry.timestamp).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}