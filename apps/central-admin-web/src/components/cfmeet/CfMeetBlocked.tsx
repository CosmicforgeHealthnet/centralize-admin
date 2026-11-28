"use client";

// Honest "blocked" display for CF Meet collections, reports, modules and
// commands: the exposure state and every blocker with its reason. A blocked
// collection is never shown as an empty list.

import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Blocker } from "@/types/products.types";
import { blockerText } from "./catalog";

const STATE_LABEL: Record<string, string> = {
  READ_ONLY: "Readable",
  AVAILABLE: "Available",
  DISABLED: "Disabled",
  BLOCKED_DEPENDENCY: "Blocked",
  BLOCKED_POLICY: "Blocked by policy",
  UNAVAILABLE: "Unavailable",
  NOT_A_READ: "Not a read",
  INTERNAL_SYNC_ONLY: "Sync only",
};

const STATE_TONE: Record<string, string> = {
  READ_ONLY: "border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  AVAILABLE: "border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  DISABLED: "border-border bg-muted text-muted-foreground",
  BLOCKED_DEPENDENCY: "border-amber-600/30 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  BLOCKED_POLICY: "border-red-600/30 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300",
};

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

export function StateBadge({ state, className }: { state: string; className?: string }) {
  return (
    <span title={state} className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", STATE_TONE[state] ?? "border-border bg-muted text-muted-foreground", className)}>
      {stateLabel(state)}
    </span>
  );
}

export function BlockerList({ blockers, className }: { blockers: Blocker[]; className?: string }) {
  if (blockers.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1.5", className)}>
      {blockers.map((b, i) => (
        <li key={`${b.code}-${i}`} className="text-[12px] leading-relaxed text-muted-foreground">
          <span className="font-mono text-[11px] text-foreground">{b.code}</span>
          {" — "}
          {b.detail || blockerText(b.code)}
        </li>
      ))}
    </ul>
  );
}

/** Lock panel for something that cannot be read now, with its state and reasons. */
export function BlockedPanel({ title, state, blockers, compact = false }: { title: string; state: string; blockers: Blocker[]; compact?: boolean }) {
  return (
    <section role="status" aria-label={`${title} blocked`} className={cn("flex flex-col gap-2 rounded-lg border border-dashed border-border bg-card", compact ? "p-3" : "p-4")}>
      <div className="flex flex-wrap items-center gap-2">
        <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-[13px] font-semibold text-foreground">{title} is not available</h3>
        <StateBadge state={state} />
      </div>
      <p className="text-[12px] text-muted-foreground">
        CF Meet Admin does not serve this yet. Nothing is shown in its place, so an empty screen here never means &ldquo;no records&rdquo;.
      </p>
      <BlockerList blockers={blockers} />
    </section>
  );
}
