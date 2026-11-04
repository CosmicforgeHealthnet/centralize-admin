"use client";

import { Inbox } from "lucide-react";

interface EmptyStateProps {
  message: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: React.ElementType;
}

export default function EmptyState({ message, description, actionLabel, onAction, icon: Icon = Inbox }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-64 px-5 py-12 text-center">
      <span aria-hidden="true" className="mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-border bg-muted/60 text-muted-foreground"><Icon className="h-7 w-7" strokeWidth={1.75} /></span>
      <p className="text-base font-semibold tracking-tight text-foreground">{message}</p>
      {description && (
        <p className="mt-2 max-w-sm text-pretty text-sm leading-6 text-muted-foreground">{description}</p>
      )}
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}