"use client";

import { Search } from "lucide-react";

interface SelectFilter {
  key: string;
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
}

interface FilterBarProps {
  dateRange?: { from: string; to: string; onChange: (from: string, to: string) => void };
  selects?: SelectFilter[];
  search?: { value: string; placeholder?: string; onChange: (value: string) => void };
  onReset?: () => void;
  activeFilterCount?: number;
}

const controlClass =
  "font-poppins text-[12px] bg-card border border-border rounded-lg text-foreground transition-colors hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export default function FilterBar({ dateRange, selects, search, onReset, activeFilterCount }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {dateRange && (
        <div
          className={`flex items-center gap-1 w-full sm:w-auto bg-card border border-border rounded-lg p-1 transition-colors hover:border-muted-foreground/40 focus-within:ring-2 focus-within:ring-primary/40`}
        >
          <input
            type="date"
            aria-label="From date"
            value={dateRange.from}
            onChange={(e) => dateRange.onChange(e.target.value, dateRange.to)}
            max={dateRange.to}
            className="font-poppins text-[12px] flex-1 sm:flex-none min-w-0 bg-transparent rounded-md px-2 py-1 text-foreground focus-visible:outline-none"
          />
          <span className="w-px h-4 bg-border shrink-0" />
          <input
            type="date"
            aria-label="To date"
            value={dateRange.to}
            onChange={(e) => dateRange.onChange(dateRange.from, e.target.value)}
            min={dateRange.from}
            className="font-poppins text-[12px] flex-1 sm:flex-none min-w-0 bg-transparent rounded-md px-2 py-1 text-foreground focus-visible:outline-none"
          />
        </div>
      )}

      {selects?.map((s) => (
        <select
          key={s.key}
          aria-label={s.label}
          value={s.value}
          onChange={(e) => s.onChange(e.target.value)}
          className={`${controlClass} w-full sm:w-auto px-2.5 py-1.5 cursor-pointer`}
        >
          {s.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ))}

      {search && (
        <div className="relative flex-1 min-w-[160px] sm:min-w-[200px] w-full sm:w-auto">
          <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search.value}
            placeholder={search.placeholder ?? "Search"}
            onChange={(e) => search.onChange(e.target.value)}
            className={`${controlClass} w-full pl-8 pr-3 py-1.5`}
          />
        </div>
      )}

      {!!activeFilterCount && onReset && (
        <button
          onClick={onReset}
          className="font-poppins text-[11px] font-medium text-muted-foreground hover:text-foreground shrink-0 sm:ml-auto underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded px-1"
        >
          Reset ({activeFilterCount})
        </button>
      )}
    </div>
  );
}