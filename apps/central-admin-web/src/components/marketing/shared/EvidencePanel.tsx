"use client";

interface EvidenceRow {
  label: string;
  value: string | number | null;
  suffix?: string;
}

interface EvidencePanelProps {
  rows: EvidenceRow[];
  window?: { from: string; to: string };
  ruleVersion?: string;
  generatedAt?: string;
}

function formatValue(value: string | number | null, suffix?: string): string {
  if (value === null || value === undefined) return "Not available";
  return `${value}${suffix ?? ""}`;
}

export default function EvidencePanel({ rows, window, ruleVersion, generatedAt }: EvidencePanelProps) {
  return (
    <div className="rounded-[10px] border border-border bg-muted/30 p-3.5">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <p className="text-[10px] font-poppins uppercase tracking-wide text-muted-foreground/70">
              {row.label}
            </p>
            <p
              className={`text-[13px] font-poppins font-medium mt-0.5 ${
                row.value === null ? "text-muted-foreground italic" : "text-foreground"
              }`}
            >
              {formatValue(row.value, row.suffix)}
            </p>
          </div>
        ))}
      </div>
      {(window || ruleVersion || generatedAt) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-border/70">
          {window && (
            <span className="text-[11px] font-poppins text-muted-foreground">
              Window: {window.from} → {window.to}
            </span>
          )}
          {ruleVersion && (
            <span className="text-[11px] font-poppins text-muted-foreground">Rule: {ruleVersion}</span>
          )}
          {generatedAt && (
            <span className="text-[11px] font-poppins text-muted-foreground">
              Generated: {new Date(generatedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}