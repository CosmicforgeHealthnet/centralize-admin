"use client";

// One exact value per scope dimension, chosen from the staff member's
// effective CF Meet scope (GET /api/products). Never "all": CF Meet reads are
// always for one market, organization, zone and tenant.

import type { ProductScope, ScopeDimension } from "@/types/products.types";
import { SCOPE_DIMENSIONS, type CfMeetScope } from "./catalog";

const LABEL: Record<ScopeDimension, string> = { market: "Market", organization: "Organization", zone: "Zone", tenant: "Tenant" };

export default function ScopeSelector({ effective, value, onChange }: { effective: ProductScope | undefined; value: CfMeetScope; onChange: (next: CfMeetScope) => void }) {
  return (
    <fieldset className="flex flex-wrap items-end gap-3">
      <legend className="sr-only">CF Meet scope</legend>
      {SCOPE_DIMENSIONS.map((dim) => {
        const options = effective?.[dim] ?? [];
        const id = `cfmeet-scope-${dim}`;
        return (
          <div key={dim} className="flex min-w-[120px] flex-col gap-1">
            <label htmlFor={id} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{LABEL[dim]}</label>
            {options.length === 0 ? (
              <span id={id} className="rounded-md border border-dashed border-border px-2 py-1.5 text-[12px] text-muted-foreground">Not in your grant</span>
            ) : (
              <select
                id={id}
                value={value[dim]}
                disabled={options.length === 1}
                onChange={(e) => onChange({ ...value, [dim]: e.target.value })}
                className="rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-100"
              >
                {options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
