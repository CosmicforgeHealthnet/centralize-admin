"use client";

// Shows why a product capability cannot be used right now (its live state
// and blocker codes from GET /{p}/capabilities). Blocked is never shown as
// "empty".

import { Lock } from "lucide-react";
import type { ProductCapability } from "@/types/products.types";

const USABLE = ["AVAILABLE", "READ_ONLY"];

/** True when a capability's live state allows using it (reads: READ_ONLY; commands: AVAILABLE). */
export function capabilityUsable(capability: Pick<ProductCapability, "state" | "kind"> | null | undefined): boolean {
  if (!capability) return false;
  return capability.kind === "COMMAND" ? capability.state === "AVAILABLE" : USABLE.includes(capability.state);
}

const STATE_TEXT: Record<string, string> = {
  DISABLED: "switched off",
  BLOCKED_POLICY: "blocked by policy",
  BLOCKED_DEPENDENCY: "blocked by a dependency",
  UNAVAILABLE: "unavailable",
};

export default function CapabilityNotice({ title, capability }: { title: string; capability: ProductCapability }) {
  return (
    <section role="alert" aria-label={`${title} blocked`} className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card p-4 text-center">
      <Lock className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title} blocked</h3>
      <p className="max-w-md font-poppins text-[12px] text-muted-foreground">
        <span className="font-mono">{capability.id}</span> is {STATE_TEXT[capability.state] ?? capability.state.toLowerCase()} for this product right now. Nothing can be read or
        changed here until the product owner and HQ switch it on.
      </p>
      {capability.blockers.length > 0 && (
        <ul className="flex max-w-md flex-col gap-1 text-left">
          {capability.blockers.map((b) => (
            <li key={b.code} className="font-poppins text-[11px] text-muted-foreground">
              <span className="font-mono text-[10px] text-foreground">{b.code}</span> {b.detail}
            </li>
          ))}
        </ul>
      )}
      <p className="font-mono text-[10px] text-muted-foreground">State: {capability.state}</p>
    </section>
  );
}
