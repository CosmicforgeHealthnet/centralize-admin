"use client";

import Link from "next/link";
import { CircleAlert, FileQuestion, Loader2, LockKeyhole, LogIn, PowerOff, RefreshCw, Timer, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { classifyMailError } from "@/lib/mail.service";
import MailState, { stateActionClass } from "./MailState";

interface PermissionBoundaryProps {
  isLoading?: boolean;
  error?: unknown;
  retry?: () => void;
  forbiddenMessage?: string;
  loadingLabel?: string;
  compact?: boolean;
  children: ReactNode;
}

/** Consistent feedback without showing private content or raw server errors. */
export default function PermissionBoundary({ isLoading, error, retry, forbiddenMessage, loadingLabel = "Loading", compact, children }: PermissionBoundaryProps) {
  if (isLoading) return <div role="status" aria-live="polite" aria-busy="true" className={`flex items-center justify-center gap-2 text-xs text-muted-foreground ${compact ? "min-h-28 p-4" : "min-h-[200px] p-8"}`}><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{loadingLabel}…</div>;
  if (!error) return <>{children}</>;
  const info = classifyMailError(error);
  const retryAction = (label = "Try again") => retry ? <button type="button" onClick={retry} className={stateActionClass}><RefreshCw size={14} aria-hidden="true" />{label}</button> : undefined;
  if (info.status === 401) return <MailState compact={compact} icon={LogIn} tone="access" role="alert" title="Sign in required" description="Your session has ended. Sign in again to continue." actions={<Link href="/" className={stateActionClass}><LogIn size={14} aria-hidden="true" />Sign in again</Link>} />;
  if (info.status === 429) return <MailState compact={compact} icon={Timer} tone="info" role="alert" title="Too many requests" description="Please wait a moment before trying again." actions={retryAction()} />;
  switch (info.kind) {
    case "disabled":
      return info.code === "MAIL_DISABLED"
        ? <MailState compact={compact} icon={PowerOff} tone="info" title="Mail is not enabled" description="Mail is not available in this environment yet. An administrator needs to complete activation." />
        : <MailState compact={compact} icon={CircleAlert} tone="info" title="Service temporarily unavailable" description="This feature is not available right now. Try again shortly. If it continues, contact your administrator." actions={retryAction()} />;
    case "forbidden":
      return <MailState compact={compact} icon={LockKeyhole} tone="access" role="alert" title="Access denied" description={forbiddenMessage || "You don’t have permission to view this content. Ask your administrator if you need access."} />;
    case "notFound":
      return <MailState compact={compact} icon={FileQuestion} title="Not found" description="This item is unavailable, or you no longer have access to it." />;
    case "network":
      return <MailState compact={compact} icon={WifiOff} role="alert" tone="error" title="Connection unavailable" description="We couldn’t reach the service. Check your internet connection and try again." actions={retryAction()} />;
    case "conflict":
      return <MailState compact={compact} icon={RefreshCw} tone="info" role="alert" title="Content has changed" description="This item was updated elsewhere. Refresh to see the latest version." actions={retryAction("Refresh")} />;
    default:
      return <MailState compact={compact} icon={CircleAlert} tone="error" role="alert" title="Unable to load content" description="We couldn’t load this information. Try again. If the problem continues, contact your administrator." actions={retryAction()} />;
  }
}
