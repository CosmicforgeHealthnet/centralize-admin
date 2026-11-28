"use client";

// Exact scope per dimension (market, organization, zone, tenant). Values are
// typed as comma/space separated exact values; wildcards are refused here as
// they are by PIC. Optional "allowed" scope shows (and checks) the product's
// registry limits.

import { Field, inputClass } from "./admin-ui";
import { parseScopeValues, SCOPE_DIMENSIONS, type ExactScope, type ScopeDimension } from "@/lib/product-integrations.service";

export type ScopeText = Partial<Record<ScopeDimension, string>>;

export interface ScopeResult {
  scope: ExactScope;
  error: string | null;
}

/** Turns the editor's text into an exact scope, with the first problem found. */
export function scopeFromText(text: ScopeText, { dimensions = SCOPE_DIMENSIONS, required = [] as readonly ScopeDimension[], allowed }: { dimensions?: readonly ScopeDimension[]; required?: readonly ScopeDimension[]; allowed?: ExactScope | null } = {}): ScopeResult {
  const scope: ExactScope = {};
  for (const dim of dimensions) {
    const { values, error } = parseScopeValues(text[dim] ?? "");
    if (error) return { scope, error: `${dim}: ${error}` };
    if (values.length === 0) {
      if (required.includes(dim)) return { scope, error: `${dim}: at least one exact value is required` };
      continue;
    }
    const limit = allowed?.[dim];
    const outside = limit ? values.filter((v) => !limit.includes(v)) : [];
    if (outside.length) return { scope, error: `${dim}: ${outside.join(", ")} is outside the product's allowed scope` };
    scope[dim] = values;
  }
  return { scope, error: null };
}

export default function ScopeEditor({
  idPrefix,
  value,
  onChange,
  dimensions = SCOPE_DIMENSIONS,
  required = [],
  allowed,
  error,
}: {
  idPrefix: string;
  value: ScopeText;
  onChange: (next: ScopeText) => void;
  dimensions?: readonly ScopeDimension[];
  required?: readonly ScopeDimension[];
  allowed?: ExactScope | null;
  error?: string | null;
}) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <legend className="px-1 font-poppins text-[12px] font-semibold text-foreground">Scope (exact values only)</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {dimensions.map((dim) => {
          const id = `${idPrefix}-scope-${dim}`;
          const limit = allowed?.[dim];
          return (
            <Field
              key={dim}
              id={id}
              label={`${dim[0].toUpperCase()}${dim.slice(1)}${required.includes(dim) ? " (required)" : ""}`}
              hint={limit ? `Allowed: ${limit.join(", ")}` : "Comma separated; no wildcards"}
            >
              <input id={id} className={inputClass} value={value[dim] ?? ""} autoComplete="off" onChange={(e) => onChange({ ...value, [dim]: e.target.value })} />
            </Field>
          );
        })}
      </div>
      {error && <p className="font-poppins text-[11px] text-red-600">{error}</p>}
    </fieldset>
  );
}
