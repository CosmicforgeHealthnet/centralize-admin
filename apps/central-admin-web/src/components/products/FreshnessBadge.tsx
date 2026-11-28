"use client";

// As-of time, freshness and coverage of a product figure. Every product
// figure must show these three; "unknown" is shown as unknown, never hidden.

import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Coverage, DataQuality, Freshness, MetricObservation } from "@/types/products.types";

const FRESHNESS_LABEL: Record<Freshness, string> = { FRESH: "Fresh", STALE: "Stale", UNKNOWN: "Freshness unknown" };
const COVERAGE_LABEL: Record<Coverage, string> = { COMPLETE: "Complete coverage", PARTIAL: "Partial coverage", NONE: "No coverage", UNKNOWN: "Coverage unknown" };
const FRESHNESS_TONE: Record<Freshness, string> = {
  FRESH: "border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  STALE: "border-amber-600/30 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  UNKNOWN: "border-border bg-muted text-muted-foreground",
};
const COVERAGE_TONE: Record<Coverage, string> = {
  COMPLETE: "border-border bg-transparent text-foreground",
  PARTIAL: "border-amber-600/30 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  NONE: "border-red-600/30 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  UNKNOWN: "border-border bg-muted text-muted-foreground",
};

/** Quality triple of one metric observation (it reports `source_observed_at`). */
export function observationQuality(observation: Pick<MetricObservation, "source_observed_at" | "freshness" | "coverage">): DataQuality {
  return { as_of: observation.source_observed_at, freshness: observation.freshness, coverage: observation.coverage };
}

/** Formats an ISO time for display; returns null for missing/invalid values. */
export function formatAsOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export interface FreshnessBadgeProps {
  /** An envelope (or anything with as_of, freshness and coverage). */
  quality: DataQuality;
  /** Single-line, smaller rendering for cards and table headers. */
  compact?: boolean;
  /** Prefix for the time, default "As of". */
  asOfLabel?: string;
  className?: string;
}

export default function FreshnessBadge({ quality, compact = false, asOfLabel = "As of", className }: FreshnessBadgeProps) {
  const freshness: Freshness = FRESHNESS_LABEL[quality.freshness] ? quality.freshness : "UNKNOWN";
  const coverage: Coverage = COVERAGE_LABEL[quality.coverage] ? quality.coverage : "UNKNOWN";
  const asOf = formatAsOf(quality.as_of);
  const pill = cn("inline-flex items-center rounded-full border px-2 py-0.5 font-medium", compact ? "text-[10px]" : "text-[11px]");
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-muted-foreground", compact ? "text-[10px]" : "text-[11px]", className)}>
      <span className="inline-flex items-center gap-1">
        <Clock className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden="true" />
        {asOf ? (
          <span>
            {asOfLabel} <time dateTime={quality.as_of as string} title={quality.as_of as string}>{asOf}</time>
          </span>
        ) : (
          <span>No source observation</span>
        )}
      </span>
      <span className={cn(pill, FRESHNESS_TONE[freshness])}>{FRESHNESS_LABEL[freshness]}</span>
      <span className={cn(pill, COVERAGE_TONE[coverage])}>{COVERAGE_LABEL[coverage]}</span>
    </div>
  );
}
