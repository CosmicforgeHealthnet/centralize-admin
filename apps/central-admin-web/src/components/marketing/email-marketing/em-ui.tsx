"use client";

import type { ReactNode } from "react";

export const emInput =
  "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] text-foreground outline-none focus:border-primary disabled:bg-muted disabled:text-muted-foreground";
export const emBtn =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50";
export const emBtnOutline =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-foreground hover:bg-muted disabled:opacity-50";

export function EmCard({ title, actions, children, id }: { title?: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="rounded-[12px] border border-border bg-card p-4" aria-labelledby={title && id ? id : undefined}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {title && (
            <h2 id={id} className="text-[13px] font-semibold text-foreground">
              {title}
            </h2>
          )}
          <div className="ml-auto flex gap-2">{actions}</div>
        </div>
      )}
      {children}
    </section>
  );
}

export function EmField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">
      {label}
      {children}
      {hint && <span className="font-normal">{hint}</span>}
    </label>
  );
}

const TONES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  READY_FOR_REVIEW: "bg-amber-50 text-amber-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-700",
  GRANTED: "bg-emerald-50 text-emerald-700",
  PENDING_CONFIRMATION: "bg-amber-50 text-amber-700",
  WITHDRAWN: "bg-red-50 text-red-700",
  ACTIVE: "bg-emerald-50 text-emerald-700",
  UNSUBSCRIBED: "bg-red-50 text-red-700",
  BOUNCED: "bg-red-50 text-red-700",
  COMPLAINED: "bg-red-50 text-red-700",
  SUPPRESSED: "bg-red-50 text-red-700",
};

export function EmBadge({ value }: { value: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${TONES[value] ?? "bg-muted text-muted-foreground"}`}>{value.replace(/_/g, " ")}</span>;
}

export function EmMessage({ message, tone = "info" }: { message: string | null; tone?: "info" | "error" }) {
  if (!message) return null;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`text-[11px] ${tone === "error" ? "text-red-600" : "text-muted-foreground"}`}>
      {message}
    </p>
  );
}
