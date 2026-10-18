"use client";

interface MetricCardProps {
  label: string;
  value: string | number | null;
  change?: string;
  up?: boolean;
  unavailableReason?: string;
  freshness?: string;
}

export default function MetricCard({ label, value, change, up, unavailableReason, freshness }: MetricCardProps) {
  const isUnavailable = value === null || value === undefined;

  return (
    <div className="bg-card rounded-2xl border border-border p-3.5 sm:p-4 flex flex-col gap-1.5 min-w-0 shadow-sm hover:border-muted-foreground/40 hover:shadow-md transition-all">
      <span className="font-poppins text-[11px] sm:text-[12px] text-muted-foreground truncate">{label}</span>

      {isUnavailable ? (
        <span className="font-poppins text-[14px] sm:text-[16px] font-medium text-muted-foreground italic truncate">
          {unavailableReason ?? "Not available"}
        </span>
      ) : (
        <span className="font-poppins text-[18px] sm:text-[22px] font-bold text-foreground truncate">
          {typeof value === "number" ? value.toLocaleString() : value}
        </span>
      )}

      {(change || freshness) && (
        <div className="flex items-center gap-2 flex-wrap">
          {change && (
            <span
              className={`font-poppins text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${
                up ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"
              }`}
            >
              {up ? "↑" : "↓"} {change}
            </span>
          )}
          {freshness && <span className="font-poppins text-[10px] text-muted-foreground truncate">{freshness}</span>}
        </div>
      )}
    </div>
  );
}