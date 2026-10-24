"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

// An unexpected render/runtime error must not blank the entire Admin shell.
// Dependency/network errors are handled within their individual widgets.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Do not print PII, credentials or source responses into the browser.
    console.error("Dashboard rendering failed", { name: error.name, digest: error.digest });
  }, [error]);

  return (
    <section role="alert" className="rounded-lg border border-border bg-card px-6 py-12 text-center">
      <AlertTriangle aria-hidden="true" className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
      <h1 className="text-lg font-semibold">This dashboard view could not be displayed</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Navigation and other Admin modules remain available. Retry this view or contact support if it continues.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-semibold hover:bg-muted"
      >
        <RefreshCw aria-hidden="true" className="h-4 w-4" />
        Retry this view
      </button>
    </section>
  );
}
