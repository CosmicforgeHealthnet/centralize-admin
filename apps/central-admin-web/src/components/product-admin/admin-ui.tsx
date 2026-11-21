"use client";

// Small building blocks shared by the product integration admin and the
// product grants manager: status pills, action buttons that explain why they
// are disabled, a confirmation dialog that names the exact server action and
// shows the server's refusal reason, and a per-page memory of permissions the
// server has refused (PIC holds the platform grants; HQ cannot list them, so
// a control is disabled once the server says the user lacks its permission).

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ErrorReference } from "@/components/products/ProductDataState";
import { formatAsOf } from "@/components/products/FreshnessBadge";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";
import { describeAdminError, isNotPermitted, toAdminApiError, type AdminApiError } from "@/lib/product-integrations.service";

// ── Formatting ────────────────────────────────────────────────────

export function when(iso: string | null | undefined): string {
  return formatAsOf(iso) ?? "—";
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}

const TONES = {
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  bad: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30",
  info: "bg-primary/10 text-primary border-primary/30",
  muted: "bg-muted text-muted-foreground border-border",
} as const;
export type Tone = keyof typeof TONES;

const STATUS_TONE: Record<string, Tone> = {
  ENABLED: "good", ACTIVE: "good", APPROVED: "good", REACHABLE: "good", HEALTHY: "good", COMPLETE: "good", NONE: "muted", CERTIFIED: "info",
  REQUESTED: "info", IDENTITY_VERIFIED: "info", CONTRACT_VALIDATED: "info", POLICY_REVIEWED: "info", CERTIFIED_STAGING: "info", VALIDATED: "info", PROPOSED: "warn",
  DRAFT: "muted", SUPERSEDED: "muted", NOT_STARTED: "muted", UNKNOWN: "muted", RETIRED: "muted", NOT_YET_VALID: "warn", EXPIRED: "muted",
  SUSPENDED: "warn", LAGGING: "warn", DEGRADED: "warn", PARTIAL: "warn", ADDITIVE_PENDING_REVIEW: "warn", STOPPED: "warn", GAP_DETECTED: "bad",
  REJECTED: "bad", REVOKED: "bad", UNREACHABLE: "bad", FAILING: "bad", POLICY_BLOCKED: "bad", BREAKING_DETECTED: "bad", IDENTITY_MISMATCH: "bad",
  MANIFEST_INVALID: "bad", MANIFEST_EXPIRED: "bad", DENY: "bad", ALLOW: "good",
};

export function StatusPill({ value, tone, label }: { value: string | null | undefined; tone?: Tone; label?: string }) {
  const v = value ?? "UNKNOWN";
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold", TONES[tone ?? STATUS_TONE[v] ?? "muted"])}>
      {label ? `${label}: ` : ""}
      {v}
    </span>
  );
}

export function Card({ title, description, actions, children, className, labelledBy }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; labelledBy?: string }) {
  const id = labelledBy ?? `card-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-3 rounded-xl border border-border bg-card p-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={id} className="font-poppins text-[14px] font-semibold text-foreground">{title}</h3>
          {description && <p className="mt-0.5 font-poppins text-[12px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 flex-col">
          <dt className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{k}</dt>
          <dd className="break-all font-poppins text-[12px] text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ScopeList({ scope }: { scope: Partial<Record<string, string[]>> | null | undefined }) {
  const entries = Object.entries(scope ?? {}).filter(([, v]) => Array.isArray(v) && v.length > 0);
  if (entries.length === 0) return <span className="text-muted-foreground">No scope</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {entries.map(([dim, values]) => (
        <span key={dim} className="font-mono text-[11px]">
          {dim}: {(values as string[]).join(", ")}
        </span>
      ))}
    </span>
  );
}

// ── Current staff member ──────────────────────────────────────────

/** The signed-in staff id, as PIC sees it (the gateway's delegation `sub`). */
export function useStaffId(): string | null {
  return useAuthStore((s) => (s.user?.id ? String(s.user.id) : null));
}

// ── Permissions the server refused ────────────────────────────────

interface RefusalMemo {
  refused: Record<string, string>;
  record: (permission: string, error: unknown) => void;
}

const RefusalContext = createContext<RefusalMemo | null>(null);

export function RefusalProvider({ children }: { children: ReactNode }) {
  const [refused, setRefused] = useState<Record<string, string>>({});
  const record = useCallback((permission: string, error: unknown) => {
    if (!isNotPermitted(error)) return;
    const reason = toAdminApiError(error).reason ?? "FORBIDDEN";
    setRefused((prev) => (prev[permission] === reason ? prev : { ...prev, [permission]: reason }));
  }, []);
  const value = useMemo(() => ({ refused, record }), [refused, record]);
  return <RefusalContext.Provider value={value}>{children}</RefusalContext.Provider>;
}

/** Why a platform permission is known to be refused for this user, or null. */
export function useRefusal() {
  const ctx = useContext(RefusalContext);
  return {
    reasonFor: (permission: string): string | null => ctx?.refused[permission] ?? null,
    record: ctx?.record ?? (() => {}),
  };
}

// ── Buttons ───────────────────────────────────────────────────────

const BUTTON = {
  primary: "bg-primary text-white hover:bg-primary/90 border-primary",
  secondary: "bg-card text-foreground hover:bg-muted border-border",
  danger: "bg-card text-red-600 hover:bg-red-500/10 border-red-500/40",
} as const;

export interface ActionButtonProps {
  label: string;
  onClick: () => void;
  variant?: keyof typeof BUTTON;
  /** When set, the button is disabled and this explanation is shown next to it. */
  disabledReason?: string | null;
  busy?: boolean;
  className?: string;
  ariaLabel?: string;
}

/** A button that never hides WHY it cannot be used. */
export function ActionButton({ label, onClick, variant = "secondary", disabledReason, busy = false, className, ariaLabel }: ActionButtonProps) {
  const disabled = Boolean(disabledReason) || busy;
  return (
    <span className={cn("inline-flex flex-col items-start gap-0.5", className)}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        title={disabledReason ?? undefined}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 font-poppins text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50",
          BUTTON[variant],
        )}
      >
        {busy ? "Working…" : label}
      </button>
      {disabledReason && <span className="max-w-[260px] font-poppins text-[10px] leading-snug text-muted-foreground">{disabledReason}</span>}
    </span>
  );
}

// ── Server error block ────────────────────────────────────────────

/** Shows a refusal exactly as the server reported it: sentence, code/reason, details, reference. */
export function ServerError({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e: AdminApiError = toAdminApiError(error);
  return (
    <div role="alert" className={cn("flex flex-col gap-1 rounded-lg border border-red-500/40 bg-red-500/5 p-2.5", className)}>
      <p className="font-poppins text-[12px] font-semibold text-red-700 dark:text-red-400">
        {e.outcomeUnknown ? "Outcome not known" : "Refused"}: {describeAdminError(e)}
      </p>
      {e.detail.length > 0 && (
        <ul className="list-disc pl-4 font-mono text-[10px] text-muted-foreground">
          {e.detail.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      <ErrorReference error={e} />
    </div>
  );
}

// ── Inputs ────────────────────────────────────────────────────────

export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-poppins text-[12px] font-semibold text-foreground">{label}</label>
      {children}
      {error ? (
        <span id={`${id}-error`} className="font-poppins text-[11px] text-red-600">{error}</span>
      ) : hint ? (
        <span id={`${id}-hint`} className="font-poppins text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

export const inputClass = "h-9 w-full rounded-lg border border-border bg-muted px-3 font-poppins text-[13px] text-foreground outline-none focus:border-primary";

// ── Confirmation dialog ───────────────────────────────────────────

export interface ConfirmField {
  name: string;
  label: string;
  required: boolean;
  pattern: RegExp;
  placeholder?: string;
  hint?: string;
  /** Upper-cases input (reason codes). */
  upper?: boolean;
}

export interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog heading, e.g. "Confirm verify-identity". */
  title: string;
  /** The exact server action, e.g. "POST …/verify-identity (REQUESTED → IDENTITY_VERIFIED)". */
  action: string;
  description?: ReactNode;
  /** Requirements the server enforces for this action (two-person rule, evidence, revision). */
  requirements?: string[];
  fields?: ConfirmField[];
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: unknown;
  onConfirm: (values: Record<string, string>) => void;
}

export function ConfirmActionDialog({ open, onOpenChange, title, action, description, requirements = [], fields = [], confirmLabel, danger = false, busy = false, error, onConfirm }: ConfirmActionDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const problems = fields.map((f) => {
    const v = (values[f.name] ?? "").trim();
    if (!v) return f.required ? `${f.label} is required` : null;
    return f.pattern.test(v) ? null : `${f.label} is not in the accepted format`;
  });
  const valid = problems.every((p) => p === null);
  const titleId = `confirm-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setValues({});
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg" aria-labelledby={titleId}>
        <DialogTitle id={titleId} className="font-poppins text-[15px]">{title}</DialogTitle>
        <DialogDescription className="font-mono text-[11px] text-muted-foreground">{action}</DialogDescription>
        {description && <div className="font-poppins text-[12px] text-foreground">{description}</div>}
        {requirements.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/40 p-2.5">
            <p className="font-poppins text-[11px] font-semibold text-foreground">The server enforces</p>
            <ul className="mt-1 list-disc pl-4 font-poppins text-[11px] text-muted-foreground">
              {requirements.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || busy) return;
            const out: Record<string, string> = {};
            for (const f of fields) {
              const v = (values[f.name] ?? "").trim();
              if (v) out[f.name] = v;
            }
            onConfirm(out);
          }}
        >
          {fields.map((f, i) => (
            <Field key={f.name} id={`${titleId}-${f.name}`} label={f.label} hint={f.hint} error={values[f.name] ? problems[i] : null}>
              <input
                id={`${titleId}-${f.name}`}
                className={inputClass}
                value={values[f.name] ?? ""}
                placeholder={f.placeholder}
                required={f.required}
                autoComplete="off"
                onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: f.upper ? e.target.value.toUpperCase() : e.target.value }))}
              />
            </Field>
          ))}
          <ServerError error={error} />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setValues({});
                onOpenChange(false);
              }}
              className="h-9 rounded-lg px-4 font-poppins text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || busy}
              className={cn(
                "h-9 rounded-lg px-4 font-poppins text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60",
                danger ? "bg-red-600 hover:bg-red-600/90" : "bg-primary hover:bg-primary/90",
              )}
            >
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A polite success line that stays until the next action. */
export function SuccessNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 font-poppins text-[12px] text-emerald-700 dark:text-emerald-400">
      {message}
    </p>
  );
}
