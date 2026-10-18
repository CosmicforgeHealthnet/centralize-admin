"use client";

import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";

interface PartialResultItem {
  label: string;
  success: boolean;
  errorCategory?: string;
  retryable?: boolean;
}

interface PartialSuccessSummaryProps {
  items: PartialResultItem[];
  onRetry?: (label: string) => void;
}

export default function PartialSuccessSummary({ items, onRetry }: PartialSuccessSummaryProps) {
  const succeeded = items.filter((i) => i.success).length;
  const failed = items.length - succeeded;

  return (
    <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 flex flex-col gap-2">
      <p className="font-poppins text-[12px] font-medium text-foreground">
        Partial results — {succeeded} succeeded, {failed} failed
      </p>
      <div className="flex flex-col gap-1.5">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {item.success ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-red-500" />
              )}
              <span className="font-poppins text-[11px] text-foreground">{item.label}</span>
              {item.errorCategory && (
                <span className="font-poppins text-[10px] text-muted-foreground">
                  ({item.errorCategory.replace(/_/g, " ")})
                </span>
              )}
            </div>
            {!item.success && item.retryable && onRetry && (
              <button
                onClick={() => onRetry(item.label)}
                className="font-poppins text-[11px] font-medium text-primary inline-flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}