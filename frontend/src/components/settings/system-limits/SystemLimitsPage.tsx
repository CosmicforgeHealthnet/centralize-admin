"use client";

import { useState, useEffect, useCallback } from "react";
import { CheckCircle2, XCircle, X, Loader2 } from "lucide-react";
import { useAdminSettingsStore } from "@/stores/admin-settings.store";
import type { PlainNumberValue, LimitsSettingKey } from "@/types/admin-settings.types";

/* ─── Toast ───────────────────────────────────────────────── */
type ToastVariant = "success" | "error";
interface ToastItem { id: string; variant: ToastVariant; title: string; message: string; }

function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((variant: ToastVariant, title: string, message: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((p) => [...p, { id, variant, title, message }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4500);
  }, []);

  const dismiss  = useCallback((id: string) => setToasts((p) => p.filter((t) => t.id !== id)), []);
  const success  = useCallback((title: string, msg: string) => show("success", title, msg), [show]);
  const error    = useCallback((title: string, msg: string) => show("error",   title, msg), [show]);

  return { toasts, dismiss, success, error };
}

const TOAST_STYLES: Record<ToastVariant, { container: string; icon: React.ReactNode }> = {
  success: {
    container: "bg-emerald-950/90 border-emerald-700/60 text-emerald-100 shadow-emerald-900/40",
    icon: <CheckCircle2 className="w-[18px] h-[18px] text-emerald-400 shrink-0 mt-0.5" />,
  },
  error: {
    container: "bg-red-950/90 border-red-700/60 text-red-100 shadow-red-900/40",
    icon: <XCircle className="w-[18px] h-[18px] text-red-400 shrink-0 mt-0.5" />,
  },
};

function Toaster({ toasts, dismiss }: { toasts: ToastItem[]; dismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const s = TOAST_STYLES[t.variant];
        return (
          <div key={t.id} className={`pointer-events-auto flex items-start gap-3 min-w-[300px] max-w-[380px] border rounded-xl px-4 py-3 shadow-xl backdrop-blur-sm animate-in slide-in-from-right-4 fade-in duration-300 ${s.container}`}>
            {s.icon}
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold leading-snug">{t.title}</p>
              <p className="text-[12px] opacity-75 mt-0.5 leading-snug">{t.message}</p>
            </div>
            <button type="button" onClick={() => dismiss(t.id)} className="shrink-0 opacity-50 hover:opacity-100 transition-opacity mt-0.5">
              <X className="w-[14px] h-[14px]" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Helpers ─────────────────────────────────────────────── */
const CATEGORY = "limits";

const LABEL: Record<LimitsSettingKey, string> = {
  max_rtc_sessions_per_doctor:          "Max active RTC sessions per doctor",
  max_consultations_per_day:            "Maximum consultations per day",
  max_delivery_assignments_per_driver:  "Max delivery assignments per driver",
  api_retry_limit:                      "API retry limit",
  event_retry_attempts:                 "Event retry attempts",
  timeout_threshold:                    "Timeout threshold",
  max_file_upload_size:                 "Max file upload size",
  log_retention_days:                   "Retention period for logs",
};

function toPlainNumber(raw: unknown): { enabled: boolean; value: number } {
  if (raw && typeof raw === "object" && "value" in raw) {
    return { enabled: typeof raw.enabled === "boolean" ? raw.enabled : true, value: Number(raw.value) || 0 };
  }
  return { enabled: true, value: 0 };
}

/* ─── Toggle ──────────────────────────────────────────────── */
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

/* ─── Plain number card ───────────────────────────────────── */
function PlainNumberCard({
  title, description, enabled, onToggle, value, onValue, saving,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  value: number;
  onValue: (v: number) => void;
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
          <p className="text-[12px] font-poppins text-primary">{description}</p>
        </div>
        <Toggle checked={enabled} onChange={onToggle} />
      </div>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onValue(Math.max(0, Number(e.target.value)))}
        disabled={!enabled}
        className="w-full h-[38px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors disabled:opacity-50"
      />
    </div>
  );
}

/* ─── Section ─────────────────────────────────────────────── */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-4">
      <h3 className="text-[14px] font-poppins font-semibold text-foreground">{title}</h3>
      {children}
    </div>
  );
}

/* ─── Warning Banner ──────────────────────────────────────── */
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

/* ─── Main ────────────────────────────────────────────────── */
export default function SystemLimitsPage() {
  const { toasts, dismiss, success: toastSuccess, error: toastError } = useToast();

  const { categorySettings, isLoading, error, loadSettingsByCategory, saveSetting, clearError } =
    useAdminSettingsStore();

  const [savingKey, setSavingKey] = useState<LimitsSettingKey | null>(null);

  /* ── Load ── */
  useEffect(() => {
    loadSettingsByCategory(CATEGORY);
  }, [loadSettingsByCategory]);

  /* ── Bubble store errors ── */
  useEffect(() => {
    if (error) {
      toastError("Failed to save", error);
      clearError();
    }
  }, [error, clearError, toastError]);

  /* ── Derive state from store ── */
  const get = useCallback(
    (key: LimitsSettingKey) => categorySettings.find((s) => s.key === key),
    [categorySettings],
  );

  const maxRTC          = toPlainNumber(get("max_rtc_sessions_per_doctor")?.value);
  const maxConsultations= toPlainNumber(get("max_consultations_per_day")?.value);
  const maxDelivery     = toPlainNumber(get("max_delivery_assignments_per_driver")?.value);
  const apiRetry        = toPlainNumber(get("api_retry_limit")?.value);
  const eventRetry      = toPlainNumber(get("event_retry_attempts")?.value);
  const timeout         = toPlainNumber(get("timeout_threshold")?.value);
  const maxFileUpload   = toPlainNumber(get("max_file_upload_size")?.value);
  const logRetention    = toPlainNumber(get("log_retention_days")?.value);

  /* ── Save helper ── */
  const save = useCallback(
    async (key: LimitsSettingKey, value: PlainNumberValue) => {
      setSavingKey(key);
      try {
        await saveSetting(CATEGORY, key, value);
        toastSuccess("Setting updated", `"${LABEL[key]}" has been saved.`);
      } finally {
        setSavingKey(null);
      }
    },
    [saveSetting, toastSuccess],
  );

  if (isLoading && categorySettings.length === 0) {
    return (
      <div className="bg-card rounded-xl border border-border p-10 flex items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-[14px] font-poppins">Loading system limits…</span>
      </div>
    );
  }

  return (
    <>
      <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-5">
        <h2 className="text-[15px] font-poppins font-semibold text-foreground">System Limits</h2>

        <WarningBanner message="Defines system-wide boundaries and thresholds." />

        {/* Operational Limits */}
        <Section title="Operational Limits">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PlainNumberCard
              title="Max active RTC sessions per doctor"
              description="Tell us the maximum active RTC sessions per doctor."
              enabled={maxRTC.enabled}
              onToggle={(enabled) => save("max_rtc_sessions_per_doctor", { ...maxRTC, enabled })}
              value={maxRTC.value}
              onValue={(value) => save("max_rtc_sessions_per_doctor", { ...maxRTC, value })}
              saving={savingKey === "max_rtc_sessions_per_doctor"}
            />
            <PlainNumberCard
              title="Maximum consultations per day"
              description="Tell us the maximum number of consultations to be hosted per day."
              enabled={maxConsultations.enabled}
              onToggle={(enabled) => save("max_consultations_per_day", { ...maxConsultations, enabled })}
              value={maxConsultations.value}
              onValue={(value) => save("max_consultations_per_day", { ...maxConsultations, value })}
              saving={savingKey === "max_consultations_per_day"}
            />
            <PlainNumberCard
              title="Max delivery assignments per driver"
              description="Tell us the maximum delivery assignments allowed per driver."
              enabled={maxDelivery.enabled}
              onToggle={(enabled) => save("max_delivery_assignments_per_driver", { ...maxDelivery, enabled })}
              value={maxDelivery.value}
              onValue={(value) => save("max_delivery_assignments_per_driver", { ...maxDelivery, value })}
              saving={savingKey === "max_delivery_assignments_per_driver"}
            />
          </div>
        </Section>

        {/* Performance Controls */}
        <Section title="Performance Controls">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PlainNumberCard
              title="API retry limit"
              description="Provide the maximum API retry limit in the field below."
              enabled={apiRetry.enabled}
              onToggle={(enabled) => save("api_retry_limit", { ...apiRetry, enabled })}
              value={apiRetry.value}
              onValue={(value) => save("api_retry_limit", { ...apiRetry, value })}
              saving={savingKey === "api_retry_limit"}
            />
            <PlainNumberCard
              title="Event retry attempts"
              description="Tell us the maximum retry attempts for events."
              enabled={eventRetry.enabled}
              onToggle={(enabled) => save("event_retry_attempts", { ...eventRetry, enabled })}
              value={eventRetry.value}
              onValue={(value) => save("event_retry_attempts", { ...eventRetry, value })}
              saving={savingKey === "event_retry_attempts"}
            />
            <PlainNumberCard
              title="Timeout threshold"
              description="Provide the timeout threshold."
              enabled={timeout.enabled}
              onToggle={(enabled) => save("timeout_threshold", { ...timeout, enabled })}
              value={timeout.value}
              onValue={(value) => save("timeout_threshold", { ...timeout, value })}
              saving={savingKey === "timeout_threshold"}
            />
          </div>
        </Section>

        {/* Data Constraints */}
        <Section title="Data Constraints">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PlainNumberCard
              title="Max file upload size"
              description="Tell us the maximum file upload size allowed (in MB)."
              enabled={maxFileUpload.enabled}
              onToggle={(enabled) => save("max_file_upload_size", { ...maxFileUpload, enabled })}
              value={maxFileUpload.value}
              onValue={(value) => save("max_file_upload_size", { ...maxFileUpload, value })}
              saving={savingKey === "max_file_upload_size"}
            />
            <PlainNumberCard
              title="Retention period for logs"
              description="Tell us how long to keep log details and timestamps (in days)."
              enabled={logRetention.enabled}
              onToggle={(enabled) => save("log_retention_days", { ...logRetention, enabled })}
              value={logRetention.value}
              onValue={(value) => save("log_retention_days", { ...logRetention, value })}
              saving={savingKey === "log_retention_days"}
            />
          </div>
        </Section>
      </div>

      <Toaster toasts={toasts} dismiss={dismiss} />
    </>
  );
}