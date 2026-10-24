"use client";

import { Loader2, Lock, PowerOff, CloudOff, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { classifyMailError } from "@/lib/mail.service";

interface PermissionBoundaryProps {
  isLoading?: boolean;
  error?: unknown;
  retry?: () => void;
  /** Custom message for the forbidden state. */
  forbiddenMessage?: string;
  loadingLabel?: string;
  compact?: boolean;
  children: ReactNode;
}

function StateCard({
  icon,
  title,
  message,
  retry,
  compact,
  role = "alert",
}: {
  icon: ReactNode;
  title: string;
  message: string;
  retry?: () => void;
  compact?: boolean;
  role?: "alert" | "status";
}) {
  return (
    <section
      role={role}
      className={`flex flex-col items-center justify-center gap-2 text-center ${compact ? "p-4 min-h-[120px]" : "p-8 min-h-[260px]"}`}
    >
      {icon}
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-md text-xs text-muted-foreground">{message}</p>
      {retry && (
        <button
          type="button"
          onClick={retry}
          className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
        >
          Retry
        </button>
      )}
    </section>
  );
}

/** Renders loading / disabled / forbidden / error states, never fabricated data. */
export default function PermissionBoundary({
  isLoading,
  error,
  retry,
  forbiddenMessage,
  loadingLabel = "Loading",
  compact,
  children,
}: PermissionBoundaryProps) {
  if (isLoading) {
    return (
      <div role="status" aria-live="polite" className={`flex items-center justify-center gap-2 text-xs text-muted-foreground ${compact ? "p-4" : "p-8 min-h-[200px]"}`}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {loadingLabel}…
      </div>
    );
  }
  if (error) {
    const info = classifyMailError(error);
    const iconClass = "h-6 w-6 text-muted-foreground";
    switch (info.kind) {
      case "disabled":
        return (
          <StateCard
            compact={compact}
            role="status"
            icon={<PowerOff className={iconClass} aria-hidden="true" />}
            title="Mail is not enabled"
            message={info.code === "MAIL_DISABLED" ? "CosmicForge Mail is currently switched off for this environment." : info.message}
          />
        );
      case "forbidden":
        return (
          <StateCard
            compact={compact}
            icon={<Lock className={iconClass} aria-hidden="true" />}
            title="Access denied"
            message={forbiddenMessage || info.message || "You do not have access to this mailbox."}
          />
        );
      case "notFound":
        return (
          <StateCard
            compact={compact}
            icon={<SearchX className={iconClass} aria-hidden="true" />}
            title="Not found"
            message="This item does not exist or you do not have access to it."
          />
        );
      default:
        return (
          <StateCard
            compact={compact}
            icon={<CloudOff className={iconClass} aria-hidden="true" />}
            title="Something went wrong"
            message={info.message}
            retry={retry}
          />
        );
    }
  }
  return <>{children}</>;
}
