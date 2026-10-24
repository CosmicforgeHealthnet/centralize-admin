"use client";

import { CloudOff, Inbox, RefreshCw } from "lucide-react";

interface ServiceDataStateProps {
  title: string;
  message?: string | null;
  retry?: () => void;
  empty?: boolean;
  compact?: boolean;
}

// Shared by current HealthNet widgets and future product Admin integrations.
// Empty results are different from a failed data source; unavailable is never 0.
export default function ServiceDataState({
  title,
  message,
  retry,
  empty = false,
  compact = false,
}: ServiceDataStateProps) {
  const Icon = empty ? Inbox : CloudOff;
  return (
    <section
      role={empty ? "status" : "alert"}
      className={`bg-card rounded-lg border border-border flex flex-col items-center justify-center gap-2 text-center ${compact ? "min-h-[110px] p-3" : "min-h-[220px] p-6"}`}
    >
      <Icon className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="max-w-md text-xs text-muted-foreground">
        {message || (empty ? "No records were returned for this period." : "This data source is temporarily unavailable. Other Admin services are not affected.")}
      </p>
      {!empty && retry && (
        <button
          type="button"
          onClick={retry}
          className="mt-1 inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </button>
      )}
    </section>
  );
}
