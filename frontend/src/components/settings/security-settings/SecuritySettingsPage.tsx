"use client";

import { useEffect, useCallback, useRef } from "react";
import { CheckCircle2, XCircle, AlertTriangle, X, Loader2 } from "lucide-react";
import { useAdminSettingsStore } from "@/stores/admin-settings.store";
import type { NumericUnitValue, BooleanValue, SecuritySettingKey } from "@/types/admin-settings.types";

// ─── Types ────────────────────────────────────────────────────────────────────

type Unit = "Seconds" | "Minutes" | "Hours" | "Days";

type ToastVariant = "success" | "error" | "warning";

interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  message: string;
}

// ─── Toast Store (module-level singleton, no context needed) ──────────────────

type ToastListener = (toasts: Toast[]) => void;
const _toasts: Toast[] = [];
const _listeners = new Set<ToastListener>();

function notify(listeners: Set<ToastListener>, arr: Toast[]) {
  listeners.forEach((l) => l([...arr]));
}

export const toast = {
  show(variant: ToastVariant, title: string, message: string) {
    const id = Math.random().toString(36).slice(2);
    _toasts.push({ id, variant, title, message });
    notify(_listeners, _toasts);
    setTimeout(() => toast.dismiss(id), 4500);
  },
  success(title: string, message: string) {
    this.show("success", title, message);
  },
  error(title: string, message: string) {
    this.show("error", title, message);
  },
  warning(title: string, message: string) {
    this.show("warning", title, message);
  },
  dismiss(id: string) {
    const i = _toasts.findIndex((t) => t.id === id);
    if (i !== -1) {
      _toasts.splice(i, 1);
      notify(_listeners, _toasts);
    }
  },
  subscribe(listener: ToastListener) {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
  },
};

// ─── Toaster (render this once, high in your tree or at the end of this page) ─

import { useState, useEffect as UE } from "react";

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  UE(() => {
    const unsub = toast.subscribe(setToasts);
    return () => { unsub(); };
  }, []);
  return toasts;
}

const VARIANT_STYLES: Record<ToastVariant, { container: string; icon: React.ReactNode }> = {
  success: {
    container:
      "bg-emerald-950/90 border-emerald-700/60 text-emerald-100 shadow-emerald-900/40",
    icon: <CheckCircle2 className="w-[18px] h-[18px] text-emerald-400 shrink-0 mt-0.5" />,
  },
  error: {
    container: "bg-red-950/90 border-red-700/60 text-red-100 shadow-red-900/40",
    icon: <XCircle className="w-[18px] h-[18px] text-red-400 shrink-0 mt-0.5" />,
  },
  warning: {
    container:
      "bg-amber-950/90 border-amber-700/60 text-amber-100 shadow-amber-900/40",
    icon: <AlertTriangle className="w-[18px] h-[18px] text-amber-400 shrink-0 mt-0.5" />,
  },
};

export function Toaster() {
  const toasts = useToasts();
  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const s = VARIANT_STYLES[t.variant];
        return (
          <div
            key={t.id}
            className={`
              pointer-events-auto flex items-start gap-3
              min-w-[300px] max-w-[380px]
              border rounded-xl px-4 py-3
              shadow-xl backdrop-blur-sm
              animate-in slide-in-from-right-4 fade-in duration-300
              ${s.container}
            `}
          >
            {s.icon}
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold leading-snug">{t.title}</p>
              <p className="text-[12px] opacity-75 mt-0.5 leading-snug">{t.message}</p>
            </div>
            <button
              onClick={() => toast.dismiss(t.id)}
              className="shrink-0 opacity-50 hover:opacity-100 transition-opacity mt-0.5"
            >
              <X className="w-[14px] h-[14px]" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LABEL: Record<SecuritySettingKey, string> = {
  session_expiry: "Session expiry time",
  token_expiry: "Token expiration duration",
  auto_logout: "Auto logout inactivity timer",
  max_login_attempts: "Max login attempts",
  lock_duration: "Account lock duration",
  require_confirmation: "Require confirmation for critical actions",
  two_step_verification: "Two-step verification for admin actions",
};

function toNumericUnit(raw: unknown): { enabled: boolean; value: number; unit: Unit } {
  if (raw && typeof raw === "object" && "value" in raw) {
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      value: Number(raw.value) || 60,
      unit: (raw.unit as Unit) || "Seconds",
    };
  }
  return { enabled: true, value: 60, unit: "Seconds" };
}

function toBoolean(raw: unknown): boolean {
  if (raw && typeof raw === "object" && "enabled" in raw) return Boolean(raw.enabled);
  return Boolean(raw);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative w-[38px] h-[22px] rounded-full transition-colors duration-200 shrink-0 ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-[3px] left-[3px] w-[16px] h-[16px] rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-[16px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function NumericCard({
  title,
  description,
  enabled,
  onToggle,
  value,
  onValue,
  unit,
  onUnit,
  units = ["Seconds", "Minutes", "Hours"],
  saving,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  value: number;
  onValue: (v: number) => void;
  unit: Unit;
  onUnit: (v: Unit) => void;
  units?: Unit[];
  saving?: boolean;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-4 relative">
      {saving && (
        <div className="absolute inset-0 rounded-xl bg-background/50 flex items-center justify-center z-10">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-[14px] font-poppins font-semibold text-foreground">{title}</p>
          <p className="text-[12px] font-poppins text-muted-foreground">{description}</p>
        </div>
        <Toggle checked={enabled} onChange={onToggle} />
      </div>
      <div className="flex flex-col xs:flex-row items-stretch xs:items-center gap-2">
        <input
          type="number"
          min={1}
          value={value}
          onChange={(e) => onValue(Math.max(1, Number(e.target.value)))}
          disabled={!enabled}
          className="w-full xs:flex-1 h-[38px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors disabled:opacity-50"
        />
        <select
          value={unit}
          onChange={(e) => onUnit(e.target.value as Unit)}
          disabled={!enabled}
          className="w-full xs:w-auto h-[38px] px-3 bg-muted border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors disabled:opacity-50"
        >
          {units.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ToggleOnlyCard({
  title,
  description,
  enabled,
  onToggle,
  saving,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  saving?: boolean;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 flex items-start justify-between gap-3 relative">
      {saving && (
        <div className="absolute inset-0 rounded-xl bg-background/50 flex items-center justify-center z-10">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        <p className="text-[14px] font-poppins font-semibold text-foreground">{title}</p>
        <p className="text-[12px] font-poppins text-muted-foreground">{description}</p>
      </div>
      <Toggle checked={enabled} onChange={onToggle} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-4">
      <h3 className="text-[14px] font-poppins font-semibold text-foreground">{title}</h3>
      {children}
    </div>
  );
}

function WarningBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 px-4 py-3">
      <p className="text-[12px] font-poppins font-semibold text-red-500 mb-1">Warning!</p>
      <p className="text-[12px] font-poppins text-red-500/80 flex items-start gap-1.5">
        <span className="shrink-0">•</span> {message}
      </p>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const CATEGORY = "security";

export default function SecuritySettingsPage() {
  const { categorySettings, isLoading, isSaving, error, loadSettingsByCategory, saveSetting, clearError } =
    useAdminSettingsStore();

  // Track which key is actively saving for per-card loading states
  const [savingKey, setSavingKey] = useState<SecuritySettingKey | null>(null);

  // ── Load on mount ──
  useEffect(() => {
    loadSettingsByCategory(CATEGORY);
  }, [loadSettingsByCategory]);

  // ── Bubble store errors into toasts ──
  useEffect(() => {
    if (error) {
      toast.error("Failed to save", error);
      clearError();
    }
  }, [error, clearError]);

  // ── Derive local state from store ──
  const getSetting = useCallback(
    (key: SecuritySettingKey) => categorySettings.find((s) => s.key === key),
    [categorySettings]
  );

  const sessionExpiry = toNumericUnit(getSetting("session_expiry")?.value);
  const tokenExpiry   = toNumericUnit(getSetting("token_expiry")?.value);
  const autoLogout    = toNumericUnit(getSetting("auto_logout")?.value);
  const maxLogin      = toNumericUnit(getSetting("max_login_attempts")?.value);
  const lockDuration  = toNumericUnit(getSetting("lock_duration")?.value);
  const requireConf   = toBoolean(getSetting("require_confirmation")?.value);
  const twoStep       = toBoolean(getSetting("two_step_verification")?.value);

  // ── Save helper ──
  const save = useCallback(
    async (key: SecuritySettingKey, value: NumericUnitValue | BooleanValue) => {
      setSavingKey(key);
      try {
        await saveSetting(CATEGORY, key, value);
        toast.success("Setting updated", `"${LABEL[key]}" has been saved.`);
      } catch {
        // error toast handled via store error effect above
      } finally {
        setSavingKey(null);
      }
    },
    [saveSetting]
  );

  if (isLoading && categorySettings.length === 0) {
    return (
      <div className="bg-card rounded-xl border border-border p-10 flex items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-[14px] font-poppins">Loading security settings…</span>
      </div>
    );
  }

  return (
    <>
      <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-5">
        <h2 className="text-[15px] font-poppins font-semibold text-foreground">Security Settings</h2>

        <WarningBanner message="Controls system protection rules. Changes take effect immediately." />

        {/* Authentication Rules */}
        <Section title="Authentication Rules">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <NumericCard
              title="Session expiry time"
              description="How long before the system auto-ends an authentication session."
              enabled={sessionExpiry.enabled}
              onToggle={(enabled) => save("session_expiry", { ...sessionExpiry, enabled })}
              value={sessionExpiry.value}
              onValue={(value) => save("session_expiry", { ...sessionExpiry, value })}
              unit={sessionExpiry.unit}
              onUnit={(unit) => save("session_expiry", { ...sessionExpiry, unit })}
              units={["Seconds", "Minutes", "Hours"]}
              saving={savingKey === "session_expiry"}
            />
            <NumericCard
              title="Token expiration duration"
              description="How long before authentication tokens expire."
              enabled={tokenExpiry.enabled}
              onToggle={(enabled) => save("token_expiry", { ...tokenExpiry, enabled })}
              value={tokenExpiry.value}
              onValue={(value) => save("token_expiry", { ...tokenExpiry, value })}
              unit={tokenExpiry.unit}
              onUnit={(unit) => save("token_expiry", { ...tokenExpiry, unit })}
              units={["Seconds", "Minutes", "Hours"]}
              saving={savingKey === "token_expiry"}
            />
            <NumericCard
              title="Auto logout inactivity timer"
              description="How long before the system auto-logs out due to inactivity."
              enabled={autoLogout.enabled}
              onToggle={(enabled) => save("auto_logout", { ...autoLogout, enabled })}
              value={autoLogout.value}
              onValue={(value) => save("auto_logout", { ...autoLogout, value })}
              unit={autoLogout.unit}
              onUnit={(unit) => save("auto_logout", { ...autoLogout, unit })}
              units={["Seconds", "Minutes", "Hours"]}
              saving={savingKey === "auto_logout"}
            />
          </div>
        </Section>

        {/* Log In Protection */}
        <Section title="Log In Protection">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <NumericCard
              title="Max login attempts"
              description="Maximum login attempts allowed within 24 hours."
              enabled={maxLogin.enabled}
              onToggle={(enabled) => save("max_login_attempts", { ...maxLogin, enabled })}
              value={maxLogin.value}
              onValue={(value) => save("max_login_attempts", { ...maxLogin, value })}
              unit={maxLogin.unit}
              onUnit={(unit) => save("max_login_attempts", { ...maxLogin, unit })}
              units={["Seconds", "Minutes", "Hours"]}
              saving={savingKey === "max_login_attempts"}
            />
            <NumericCard
              title="Account lock duration after failure"
              description="How long to lock an account after multiple failed login attempts."
              enabled={lockDuration.enabled}
              onToggle={(enabled) => save("lock_duration", { ...lockDuration, enabled })}
              value={lockDuration.value}
              onValue={(value) => save("lock_duration", { ...lockDuration, value })}
              unit={lockDuration.unit}
              onUnit={(unit) => save("lock_duration", { ...lockDuration, unit })}
              units={["Seconds", "Minutes", "Hours"]}
              saving={savingKey === "lock_duration"}
            />
          </div>
        </Section>

        {/* Admin Security */}
        <Section title="Admin Security">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ToggleOnlyCard
              title="Require confirmation for critical actions"
              description="Require admin authorization confirmation before executing critical actions."
              enabled={requireConf}
              onToggle={(enabled) => save("require_confirmation", { enabled })}
              saving={savingKey === "require_confirmation"}
            />
            <ToggleOnlyCard
              title="Two-step verification for admin actions"
              description="Require identity verification before performing admin-related actions."
              enabled={twoStep}
              onToggle={(enabled) => save("two_step_verification", { enabled })}
              saving={savingKey === "two_step_verification"}
            />
          </div>
        </Section>
      </div>

      {/* Toast portal — safe to mount here; deduplicated by module-level store */}
      <Toaster />
    </>
  );
}