"use client";

import { ChevronDown } from "lucide-react";
import { useVerificationStore } from "@/stores/verification.store";

export type { VerificationFilters } from "@/types/verification.types";

const statusOptions = ["All", "Pending", "Approved", "Failed"];
const verificationTypeOptions = ["All", "License", "Business"];

function FieldWrapper({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 flex-1 min-w-[120px]">
      <label className="text-[11px] font-poppins font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export default function VerificationFiltersBar() {
  const filters      = useVerificationStore((s) => s.filters);
  const setFilters   = useVerificationStore((s) => s.setFilters);
  const resetFilters = useVerificationStore((s) => s.resetFilters);
  const fetchList    = useVerificationStore((s) => s.fetchList);

  const inputStyles =
    "w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-[12px] font-poppins text-foreground outline-none focus:border-[#1c3866] dark:focus:border-[#8b9cf4] cursor-pointer transition-colors";

  const handleApply = () => {
    setFilters({ page: 1 });
    fetchList();
  };

  const handleClear = () => {
    resetFilters();
    fetchList();
  };

  return (
    <div className="rounded-xl p-4 bg-muted/60 border border-border">
      <div className="flex flex-wrap items-end gap-3">

        <FieldWrapper label="Start Date">
          <div className="relative">
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => setFilters({ startDate: e.target.value })}
              className={inputStyles}
            />
          </div>
        </FieldWrapper>

        <FieldWrapper label="End Date">
          <div className="relative">
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => setFilters({ endDate: e.target.value })}
              className={inputStyles}
            />
          </div>
        </FieldWrapper>

        <FieldWrapper label="Status">
          <div className="relative">
            <select
              className={inputStyles}
              value={filters.status}
              onChange={(e) => setFilters({ status: e.target.value })}
            >
              {statusOptions.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          </div>
        </FieldWrapper>

        {/* <FieldWrapper label="Verification Type">
          <div className="relative">
            <select
              className={inputStyles}
              value={filters.verificationType ?? "All"}
              onChange={(e) => setFilters({ verificationType: e.target.value } as any)}
            >
              {verificationTypeOptions.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          </div>
        </FieldWrapper> */}

        <div className="flex items-center gap-1.5 ml-auto sm:ml-0">
          <button
            onClick={handleApply}
            className="h-[36px] px-4 bg-[#1c3866] dark:bg-[#8b9cf4] dark:text-[#0f1623] text-white text-[12px] font-poppins font-medium rounded-md hover:opacity-90 transition-all whitespace-nowrap"
          >
            Apply Filter
          </button>
          <button
            onClick={handleClear}
            className="h-[36px] px-3 bg-transparent text-muted-foreground text-[12px] font-poppins font-medium hover:text-foreground transition-colors"
          >
            Clear
          </button>
        </div>

      </div>
    </div>
  );
}