"use client";

// Scope (and optional purpose) picker for product reads and commands. Values
// come from the staff member's effective scope (GET /api/products), never
// hard-coded. A dimension the grant does not enumerate can be typed when it
// is required.

import { SCOPE_DIMS, type ScopeDim } from "@/lib/products.discovery";
import type { ProductScope, ScopeQuery } from "@/types/products.types";

const LABEL: Record<ScopeDim, string> = { market: "Market", organization: "Organization", zone: "Zone", tenant: "Tenant" };

const fieldClass =
  "h-8 min-w-0 rounded-md border border-border bg-background px-2 font-poppins text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export interface ScopeBarProps {
  effective: ProductScope | undefined;
  value: ScopeQuery;
  onChange: (dim: ScopeDim, value: string) => void;
  /** Zone and tenant are required (e.g. CF Meet verification reads). */
  requireZoneTenant?: boolean;
  purpose?: string;
  purposes?: readonly string[];
  onPurposeChange?: (purpose: string) => void;
  /** Accessible name of the group. */
  label?: string;
}

export default function ScopeBar({ effective, value, onChange, requireZoneTenant = false, purpose, purposes, onPurposeChange, label = "Scope" }: ScopeBarProps) {
  return (
    <fieldset className="flex flex-wrap items-end gap-2" aria-label={label}>
      {SCOPE_DIMS.map((dim) => {
        const granted = effective?.[dim] ?? [];
        const required = dim === "market" || dim === "organization" || requireZoneTenant;
        const id = `scope-${dim}`;
        if (!granted.length && !required) return null;
        return (
          <label key={dim} htmlFor={id} className="flex min-w-[120px] flex-1 flex-col gap-1 sm:flex-none">
            <span className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{LABEL[dim]}</span>
            {granted.length ? (
              <select id={id} className={fieldClass} value={value[dim] ?? ""} onChange={(e) => onChange(dim, e.target.value)}>
                {!required && <option value="">Any</option>}
                {granted.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                className={fieldClass}
                value={value[dim] ?? ""}
                onChange={(e) => onChange(dim, e.target.value.trim())}
                placeholder={`Enter ${LABEL[dim].toLowerCase()}`}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </label>
        );
      })}
      {purposes && onPurposeChange && (
        <label htmlFor="scope-purpose" className="flex min-w-[150px] flex-1 flex-col gap-1 sm:flex-none">
          <span className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Purpose</span>
          <select id="scope-purpose" className={fieldClass} value={purpose} onChange={(e) => onPurposeChange(e.target.value)}>
            {purposes.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}
