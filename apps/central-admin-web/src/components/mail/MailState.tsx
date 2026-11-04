"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type Tone = "neutral" | "info" | "access" | "error";
const tones: Record<Tone, string> = {
  neutral: "border-border bg-muted/60 text-muted-foreground",
  info: "border-primary/10 bg-primary/5 text-primary",
  access: "border-amber-200/70 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400",
  error: "border-red-200/70 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400",
};
export const stateActionClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50";
export const stateSecondaryActionClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-xs font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export default function MailState({ icon: Icon, title, description, actions, compact = false, tone = "neutral", role = "status", headingLevel = 2 }: {
  icon: LucideIcon;
  title: string;
  description: string;
  actions?: ReactNode;
  compact?: boolean;
  tone?: Tone;
  role?: "status" | "alert";
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return <section role={role} aria-atomic="true" className={`flex flex-col items-center justify-center text-center ${compact ? "min-h-40 px-3 py-5" : "min-h-[320px] px-5 py-12 sm:px-8"}`}>
    <span aria-hidden="true" className={`mb-4 flex shrink-0 items-center justify-center rounded-2xl border ${compact ? "h-11 w-11" : "h-14 w-14"} ${tones[tone]}`}><Icon className={compact ? "h-5 w-5" : "h-6 w-6"} strokeWidth={1.6} /></span>
    <Heading className={`${compact ? "text-sm" : "text-base sm:text-lg"} font-semibold tracking-tight text-foreground`}>{title}</Heading>
    <p className={`mt-2 max-w-md text-muted-foreground ${compact ? "text-xs leading-5" : "text-sm leading-6"}`}>{description}</p>
    {actions && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
  </section>;
}
