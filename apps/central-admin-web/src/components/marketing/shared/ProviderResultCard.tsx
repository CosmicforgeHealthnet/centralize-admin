"use client";

import ProviderBadge, { BadgeProvider } from "./ProviderBadge";
import StatusChip from "./StatusChip";

interface ProviderResultCardProps {
  provider: BadgeProvider;
  identityLabel: string;
  status: string;
  providerUrl?: string;
  errorCategory?: string;
  retryable?: boolean;
  postingMode?: "DIRECT_POST" | "UPLOAD_TO_DRAFT";
  onRetry?: () => void;
  onCancel?: () => void;
  actionLoading?: boolean;
}

export default function ProviderResultCard({
  provider, identityLabel, status, providerUrl, errorCategory, retryable,
  postingMode, onRetry, onCancel, actionLoading,
}: ProviderResultCardProps) {
  const isAwaitingUserAction = status === "AWAITING_USER_ACTION";

  return (
    <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <ProviderBadge provider={provider} subtitle={identityLabel} size="sm" />
        <StatusChip status={status} />
      </div>

      {isAwaitingUserAction && postingMode === "UPLOAD_TO_DRAFT" && (
        <p className="font-poppins text-[11px] text-muted-foreground">
          Uploaded to draft — finish this post directly in the provider app to publish.
        </p>
      )}

      {errorCategory && (
        <p className="font-poppins text-[11px] text-red-500">{errorCategory.replace(/_/g, " ")}</p>
      )}

      <div className="flex items-center gap-3">
        {providerUrl && (
          <a
            href={providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-poppins text-[11px] text-primary underline"
          >
            Open in provider
          </a>
        )}
        {retryable && onRetry && (
          <button
            onClick={onRetry}
            disabled={actionLoading}
            className="font-poppins text-[11px] font-medium text-primary disabled:opacity-50"
          >
            Retry
          </button>
        )}
        {(status === "PENDING" || status === "PROCESSING") && onCancel && (
          <button
            onClick={onCancel}
            disabled={actionLoading}
            className="font-poppins text-[11px] font-medium text-muted-foreground disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}