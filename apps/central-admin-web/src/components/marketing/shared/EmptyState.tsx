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
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Icon className="w-6 h-6 text-muted-foreground" />
      <p className="font-poppins text-[13px] font-medium text-foreground">{message}</p>
      {description && (
        <p className="font-poppins text-[11px] text-muted-foreground max-w-[280px]">{description}</p>
      )}
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="font-poppins text-[12px] font-medium text-primary mt-1"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}