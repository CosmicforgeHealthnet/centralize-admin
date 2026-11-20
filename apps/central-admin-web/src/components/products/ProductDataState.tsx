"use client";

// Loading / unavailable / empty / blocked wrapper for product data, built on
// the shared ServiceDataState. Unavailable is never shown as zero or as an
// empty list; a refusal (no grant, switched off, policy, MFA) is shown as
// blocked with its reason, not as an outage.

import { useState, type ReactNode } from "react";
import { Lock, RefreshCw, ShieldCheck } from "lucide-react";
import ServiceDataState from "@/components/shared/ServiceDataState";
import { Skeleton } from "@/components/ui/skeleton";
import { useMfaStepUp } from "@/lib/mfa-step-up";
import { describeProductError, toProductApiError, type ProductApiError } from "@/lib/products.service";
import { cn } from "@/lib/utils";
import type { DataQuality } from "@/types/products.types";
import FreshnessBadge from "./FreshnessBadge";

/** What the wrapper will render for a given error. */
export type ProductDataView = "loading" | "mfa" | "blocked" | "unavailable" | "empty" | "ready";

/** Classifies an error the way ProductDataState shows it. */
export function productErrorView(error: unknown): Exclude<ProductDataView, "loading" | "empty" | "ready"> {
  const e = toProductApiError(error);
  if (e.kind === "mfa_required") return "mfa";
  if (e.kind === "blocked" || e.kind === "forbidden" || e.kind === "unauthenticated") return "blocked";
  return "unavailable";
}

/** "Reason: X · Ref: Y" line for support; never contains data. */
export function ErrorReference({ error, className }: { error: ProductApiError; className?: string }) {
  const reason = error.reason && error.reason !== error.code ? `${error.code} / ${error.reason}` : error.code;
  return (
    <p className={cn("max-w-sm break-all font-mono text-[10px] text-muted-foreground", className)}>
      Reason: {reason}
      {error.correlation_id && <> · Ref: {error.correlation_id}</>}
    </p>
  );
}

export interface ProductDataStateProps {
  /** Short name of the data, e.g. "Users" or "Meeting report". */
  title: string;
  /** True while the first load is in flight (React Query `isPending`). */
  loading?: boolean;
  /** The query error, if any (any thrown value; normalized internally). */
  error?: unknown;
  /** True when the read succeeded but returned nothing. */
  empty?: boolean;
  emptyMessage?: string;
  /** Re-runs the read (React Query `refetch`). Also used after an MFA step-up. */
  onRetry?: () => unknown;
  /** Shows a FreshnessBadge above the content when the data is ready. */
  quality?: DataQuality | null;
  /** Replaces the default skeleton. */
  loadingFallback?: ReactNode;
  compact?: boolean;
  /** Render without the card border (inside an existing card). */
  embedded?: boolean;
  children?: ReactNode;
}

export default function ProductDataState({
  title,
  loading = false,
  error,
  empty = false,
  emptyMessage,
  onRetry,
  quality,
  loadingFallback,
  compact = false,
  embedded = false,
  children,
}: ProductDataStateProps) {
  const stepUp = useMfaStepUp();
  const [confirming, setConfirming] = useState(false);

  if (error) {
    const e = toProductApiError(error);
    const view = productErrorView(e);
    if (view === "mfa" || view === "blocked") {
      const Icon = view === "mfa" ? ShieldCheck : Lock;
      const confirmAndRetry = async () => {
        setConfirming(true);
        try {
          await stepUp.requestStepUp();
          await onRetry?.();
        } catch {
          // Cancelled: stay on this panel.
        } finally {
          setConfirming(false);
        }
      };
      return (
        <section
          role="alert"
          className={cn(
            "flex flex-col items-center justify-center gap-2 text-center",
            !embedded && "rounded-lg border border-border bg-card",
            compact ? "min-h-[100px] p-2" : "min-h-[200px] p-3",
          )}
        >
          <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-xs font-semibold text-foreground">{view === "mfa" ? `${title}: confirmation needed` : `${title} blocked`}</h3>
          <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">{describeProductError(e)}</p>
          <ErrorReference error={e} />
          {view === "mfa" && stepUp.available && (
            <button
              type="button"
              onClick={() => void confirmAndRetry()}
              disabled={confirming}
              className="mt-1 inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Confirm and retry
            </button>
          )}
        </section>
      );
    }
    return (
      <div className="flex flex-col items-center">
        <ServiceDataState
          title={`${title} unavailable`}
          message={describeProductError(e)}
          retry={onRetry ? () => void onRetry() : undefined}
          compact={compact}
          embedded={embedded}
        />
        <ErrorReference error={e} className="mt-1 text-center" />
      </div>
    );
  }

  if (loading) {
    return (
      <>
        {loadingFallback ?? (
          <div role="status" aria-live="polite" aria-label={`Loading ${title}`} className={cn("flex flex-col gap-2", compact ? "p-2" : "p-3")}>
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        )}
      </>
    );
  }

  if (empty) {
    return <ServiceDataState empty title={`No ${title.toLowerCase()}`} message={emptyMessage || "The source returned no records for this scope."} compact={compact} embedded={embedded} />;
  }

  return (
    <>
      {quality && <FreshnessBadge quality={quality} compact={compact} className="mb-2" />}
      {children}
    </>
  );
}

/** Small inline refresh button with a spinner (pairs with React Query `isFetching`). */
export function RefreshButton({ onClick, busy = false, label = "Refresh" }: { onClick: () => void; busy?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden="true" />
    </button>
  );
}
