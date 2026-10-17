"use client";

import { useState, useEffect, useCallback } from "react";
import { CheckCircle2, XCircle, X, Loader2 } from "lucide-react";
import { useAdminSettingsStore } from "@/stores/admin-settings.store";
import type {
  NumericUnitValue,
  TagListValue,
  PlainNumberValue,
  TelemedicineSettingKey,
  RTCSettingKey,
  LogisticsSettingKey,
} from "@/types/admin-settings.types";

/* ─── Types ───────────────────────────────────────────────── */
type Tab = "telemedicine" | "rtc" | "logistics";
type Unit = "Seconds" | "Minutes" | "Month";

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
  const dismiss = useCallback((id: string) => setToasts((p) => p.filter((t) => t.id !== id)), []);
  const success = useCallback((t: string, m: string) => show("success", t, m), [show]);
  const error   = useCallback((t: string, m: string) => show("error",   t, m), [show]);
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
          <div key={t.id} className={`pointer-events-auto flex items-start gap-3 min-w-[280px] max-w-[360px] border rounded-xl px-4 py-3 shadow-xl backdrop-blur-sm animate-in slide-in-from-right-4 fade-in duration-300 ${s.container}`}>
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
function toNumUnit(raw: unknown, defaultUnit: Unit = "Seconds"): { enabled: boolean; value: number; unit: Unit } {
  if (raw && typeof raw === "object" && "value" in raw) {
    return { enabled: "enabled" in raw && typeof raw.enabled === "boolean" ? raw.enabled : true, value: Number(raw.value) || 0, unit: ("unit" in raw ? raw.unit as Unit : undefined) ?? defaultUnit };
  }
  return { enabled: true, value: 0, unit: defaultUnit };
}

function toTagList(raw: unknown): { enabled: boolean; tags: string[] } {
  if (raw && typeof raw === "object" && "tags" in raw) {
    return { enabled: "enabled" in raw && typeof raw.enabled === "boolean" ? raw.enabled : true, tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [] };
  }
  return { enabled: true, tags: [] };
}

function toPlain(raw: unknown): { enabled: boolean; value: number } {
  if (raw && typeof raw === "object" && "value" in raw) {
    return { enabled: "enabled" in raw && typeof raw.enabled === "boolean" ? raw.enabled : true, value: Number(raw.value) || 0 };
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
      <span className={`absolute top-[3px] left-[3px] w-[16px] h-[16px] rounded-full bg-white shadow transition-transform duration-200 ${checked ? "translate-x-[16px]" : "translate-x-0"}`} />
    </button>
  );
}

/* ─── Numeric + Unit card ─────────────────────────────────── */
function NumericSettingCard({
  title, description, enabled, onToggle, value, onValue, unit, onUnit,
  units = ["Seconds", "Minutes", "Month"], saving,
}: {
  title: string; description: string; enabled: boolean; onToggle: (v: boolean) => void;
  value: number; onValue: (v: number) => void; unit: Unit; onUnit: (v: Unit) => void;
  units?: Unit[]; saving?: boolean;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-4 relative">
      {saving && (
        <div className="absolute inset-0 rounded-xl bg-background/50 flex items-center justify-center z-10">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <p className="text-[14px] font-poppins font-semibold text-foreground">{title}</p>
          <p className="text-[12px] font-poppins text-muted-foreground">{description}</p>
        </div>
        <Toggle checked={enabled} onChange={onToggle} />
      </div>
      {/* Stack on mobile, row on sm+ */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => onValue(Math.max(0, Number(e.target.value)))}
          disabled={!enabled}
          className="w-full sm:flex-1 h-[38px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors disabled:opacity-50"
        />
        <select
          value={unit}
          onChange={(e) => onUnit(e.target.value as Unit)}
          disabled={!enabled}
          className="w-full sm:w-auto h-[38px] px-3 bg-muted border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors disabled:opacity-50"
        >
          {units.map((u) => <option key={u}>{u}</option>)}
        </select>
      </div>
    </div>
  );
}

/* ─── Tag list card ───────────────────────────────────────── */
function TagListSettingCard({
  title, description, enabled, onToggle, tags, onTags, saving,
}: {
  title: string; description: string; enabled: boolean; onToggle: (v: boolean) => void;
  tags: string[]; onTags: (v: string[]) => void; saving?: boolean;
}) {
  const [draft, setDraft] = useState("");

  const addTag = () => {
    const t = draft.trim();
    if (t && !tags.includes(t)) { onTags([...tags, t]); setDraft(""); }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-4 relative">
      {saving && (
        <div className="absolute inset-0 rounded-xl bg-background/50 flex items-center justify-center z-10">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <p className="text-[14px] font-poppins font-semibold text-foreground">{title}</p>
          <p className="text-[12px] font-poppins text-primary">{description}</p>
        </div>
        <Toggle checked={enabled} onChange={onToggle} />
      </div>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <span key={tag} className="flex items-center gap-1.5 px-3 h-[34px] bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground">
            {tag}
            <button type="button" onClick={() => onTags(tags.filter((t) => t !== tag))} className="text-muted-foreground hover:text-foreground transition-colors leading-none">×</button>
          </span>
        ))}
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTag()}
            placeholder="New rule..."
            disabled={!enabled}
            className="h-[34px] px-3 w-[130px] rounded-lg bg-muted border border-border text-[12px] font-poppins text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors disabled:opacity-50"
          />
          <button type="button" onClick={addTag} disabled={!enabled || !draft.trim()} className="h-[34px] px-2 text-[12px] font-poppins font-semibold text-primary hover:text-primary/80 transition-colors disabled:opacity-40">
            + Add
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Plain number card ───────────────────────────────────── */
function PlainNumberCard({
  title, description, enabled, onToggle, value, onValue, saving,
}: {
  title: string; description: string; enabled: boolean; onToggle: (v: boolean) => void;
  value: number; onValue: (v: number) => void; saving?: boolean;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-4 relative">
      {saving && (
        <div className="absolute inset-0 rounded-xl bg-background/50 flex items-center justify-center z-10">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <p className="text-[14px] font-poppins font-semibold text-foreground">{title}</p>
          <p className="text-[12px] font-poppins text-muted-foreground">{description}</p>
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

/* ─── Warning Banner ──────────────────────────────────────── */
function WarningBanner() {
  return (
    <div className="rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 px-4 py-3">
      <p className="text-[12px] font-poppins font-semibold text-red-500 mb-1">Warning!</p>
      <p className="text-[12px] font-poppins text-red-500/80 flex items-start gap-1.5">
        <span className="shrink-0">•</span>
        All settings filled, activated or deactivated here directly affects the product behavior!
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TAB COMPONENTS — each receives save + savingKey from parent
═══════════════════════════════════════════════════════════ */

/* ─── Telemedicine Tab ────────────────────────────────────── */
function TelemedicineTab({
  settings, save, savingKey,
}: {
  settings: ReturnType<typeof useAdminSettingsStore.getState>["categorySettings"];
  save: (key: TelemedicineSettingKey, value: unknown) => Promise<void>;
  savingKey: string | null;
}) {
  const get = (k: TelemedicineSettingKey) => settings.find((s) => s.key === k);

  const consultTimeout    = toNumUnit(get("consultation_timeout")?.value, "Seconds");
  const autoEndInactive   = toNumUnit(get("auto_end_inactive")?.value,    "Minutes");
  const autoEndUnfinished = toNumUnit(get("auto_end_unfinished")?.value,  "Minutes");
  const prescriptionExpiry= toNumUnit(get("prescription_expiry")?.value,  "Month");
  const followUp          = toTagList(get("followup_rules")?.value);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <NumericSettingCard
        title="Consultation Timeout duration"
        description="How long before consultation timeout."
        enabled={consultTimeout.enabled}
        onToggle={(enabled) => save("consultation_timeout", { ...consultTimeout, enabled })}
        value={consultTimeout.value}
        onValue={(value) => save("consultation_timeout", { ...consultTimeout, value })}
        unit={consultTimeout.unit}
        onUnit={(unit) => save("consultation_timeout", { ...consultTimeout, unit })}
        units={["Seconds", "Minutes"]}
        saving={savingKey === "consultation_timeout"}
      />
      <NumericSettingCard
        title="Auto-end inactive Consultations"
        description="How long before system auto-ends inactive consultations."
        enabled={autoEndInactive.enabled}
        onToggle={(enabled) => save("auto_end_inactive", { ...autoEndInactive, enabled })}
        value={autoEndInactive.value}
        onValue={(value) => save("auto_end_inactive", { ...autoEndInactive, value })}
        unit={autoEndInactive.unit}
        onUnit={(unit) => save("auto_end_inactive", { ...autoEndInactive, unit })}
        units={["Seconds", "Minutes"]}
        saving={savingKey === "auto_end_inactive"}
      />
      <NumericSettingCard
        title="Auto-end unfinished Consultations"
        description="How long before system auto-ends unfinished consultations."
        enabled={autoEndUnfinished.enabled}
        onToggle={(enabled) => save("auto_end_unfinished", { ...autoEndUnfinished, enabled })}
        value={autoEndUnfinished.value}
        onValue={(value) => save("auto_end_unfinished", { ...autoEndUnfinished, value })}
        unit={autoEndUnfinished.unit}
        onUnit={(unit) => save("auto_end_unfinished", { ...autoEndUnfinished, unit })}
        units={["Seconds", "Minutes"]}
        saving={savingKey === "auto_end_unfinished"}
      />
      <NumericSettingCard
        title="Prescription Expiry Duration"
        description="Invalidate prescriptions after this period."
        enabled={prescriptionExpiry.enabled}
        onToggle={(enabled) => save("prescription_expiry", { ...prescriptionExpiry, enabled })}
        value={prescriptionExpiry.value}
        onValue={(value) => save("prescription_expiry", { ...prescriptionExpiry, value })}
        unit={prescriptionExpiry.unit}
        onUnit={(unit) => save("prescription_expiry", { ...prescriptionExpiry, unit })}
        units={["Month"]}
        saving={savingKey === "prescription_expiry"}
      />
      <TagListSettingCard
        title="Follow up window rules"
        description="Provide post-consultation rules."
        enabled={followUp.enabled}
        onToggle={(enabled) => save("followup_rules", { ...followUp, enabled })}
        tags={followUp.tags}
        onTags={(tags) => save("followup_rules", { ...followUp, tags })}
        saving={savingKey === "followup_rules"}
      />
    </div>
  );
}

/* ─── RTC Tab ─────────────────────────────────────────────── */
function RTCTab({
  settings, save, savingKey,
}: {
  settings: ReturnType<typeof useAdminSettingsStore.getState>["categorySettings"];
  save: (key: RTCSettingKey, value: unknown) => Promise<void>;
  savingKey: string | null;
}) {
  const get = (k: RTCSettingKey) => settings.find((s) => s.key === k);

  const sessionTimeout    = toNumUnit(get("session_timeout")?.value,    "Seconds");
  const autoEndInactive   = toNumUnit(get("auto_end_inactive")?.value,  "Minutes");
  const reconnect         = toNumUnit(get("reconnect_allowance")?.value,"Seconds");
  const maxSession        = toNumUnit(get("max_session_duration")?.value,"Minutes");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <NumericSettingCard
        title="Session Timeout duration"
        description="How long before session timeout."
        enabled={sessionTimeout.enabled}
        onToggle={(enabled) => save("session_timeout", { ...sessionTimeout, enabled })}
        value={sessionTimeout.value}
        onValue={(value) => save("session_timeout", { ...sessionTimeout, value })}
        unit={sessionTimeout.unit}
        onUnit={(unit) => save("session_timeout", { ...sessionTimeout, unit })}
        units={["Seconds", "Minutes"]}
        saving={savingKey === "session_timeout"}
      />
      <NumericSettingCard
        title="Auto-end inactive Calls"
        description="How long before system auto-ends inactive calls."
        enabled={autoEndInactive.enabled}
        onToggle={(enabled) => save("auto_end_inactive", { ...autoEndInactive, enabled })}
        value={autoEndInactive.value}
        onValue={(value) => save("auto_end_inactive", { ...autoEndInactive, value })}
        unit={autoEndInactive.unit}
        onUnit={(unit) => save("auto_end_inactive", { ...autoEndInactive, unit })}
        units={["Seconds", "Minutes"]}
        saving={savingKey === "auto_end_inactive"}
      />
      <NumericSettingCard
        title="Reconnect allowance time window"
        description="How long is the allowance time for reconnection."
        enabled={reconnect.enabled}
        onToggle={(enabled) => save("reconnect_allowance", { ...reconnect, enabled })}
        value={reconnect.value}
        onValue={(value) => save("reconnect_allowance", { ...reconnect, value })}
        unit={reconnect.unit}
        onUnit={(unit) => save("reconnect_allowance", { ...reconnect, unit })}
        units={["Seconds", "Minutes"]}
        saving={savingKey === "reconnect_allowance"}
      />
      <NumericSettingCard
        title="Max session duration"
        description="How long is the maximum session period."
        enabled={maxSession.enabled}
        onToggle={(enabled) => save("max_session_duration", { ...maxSession, enabled })}
        value={maxSession.value}
        onValue={(value) => save("max_session_duration", { ...maxSession, value })}
        unit={maxSession.unit}
        onUnit={(unit) => save("max_session_duration", { ...maxSession, unit })}
        units={["Seconds", "Minutes", "Month"]}
        saving={savingKey === "max_session_duration"}
      />
    </div>
  );
}

/* ─── Logistics Tab ───────────────────────────────────────── */
function LogisticsTab({
  settings, save, savingKey,
}: {
  settings: ReturnType<typeof useAdminSettingsStore.getState>["categorySettings"];
  save: (key: LogisticsSettingKey, value: unknown) => Promise<void>;
  savingKey: string | null;
}) {
  const get = (k: LogisticsSettingKey) => settings.find((s) => s.key === k);

  const autoDriver  = toNumUnit(get("auto_driver_assignment_delay")?.value, "Seconds");
  const reassign    = toNumUnit(get("reassignment_trigger_time")?.value,    "Seconds");
  const timeout     = toTagList(get("delivery_timeout_rules")?.value);
  const retry       = toPlain( get("retry_delivery_attempts")?.value);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <NumericSettingCard
        title="Auto-driver assignment delay"
        description="How long before system auto-assigns a driver to an order."
        enabled={autoDriver.enabled}
        onToggle={(enabled) => save("auto_driver_assignment_delay", { ...autoDriver, enabled })}
        value={autoDriver.value}
        onValue={(value) => save("auto_driver_assignment_delay", { ...autoDriver, value })}
        unit={autoDriver.unit}
        onUnit={(unit) => save("auto_driver_assignment_delay", { ...autoDriver, unit })}
        units={["Seconds", "Minutes"]}
        saving={savingKey === "auto_driver_assignment_delay"}
      />
      <NumericSettingCard
        title="Reassignment trigger time"
        description="How long before system reassigns a driver to an order."
        enabled={reassign.enabled}
        onToggle={(enabled) => save("reassignment_trigger_time", { ...reassign, enabled })}
        value={reassign.value}
        onValue={(value) => save("reassignment_trigger_time", { ...reassign, value })}
        unit={reassign.unit}
        onUnit={(unit) => save("reassignment_trigger_time", { ...reassign, unit })}
        units={["Seconds", "Minutes"]}
        saving={savingKey === "reassignment_trigger_time"}
      />
      <TagListSettingCard
        title="Delivery timeout rules"
        description="Provide delivery timeout rules."
        enabled={timeout.enabled}
        onToggle={(enabled) => save("delivery_timeout_rules", { ...timeout, enabled })}
        tags={timeout.tags}
        onTags={(tags) => save("delivery_timeout_rules", { ...timeout, tags })}
        saving={savingKey === "delivery_timeout_rules"}
      />
      <PlainNumberCard
        title="Retry delivery attempts count"
        description="Maximum number of retry attempts for a delivery."
        enabled={retry.enabled}
        onToggle={(enabled) => save("retry_delivery_attempts", { ...retry, enabled })}
        value={retry.value}
        onValue={(value) => save("retry_delivery_attempts", { ...retry, value })}
        saving={savingKey === "retry_delivery_attempts"}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════════ */

const TABS: { label: string; value: Tab; category: string }[] = [
  { label: "Telemedicine", value: "telemedicine", category: "behavior.telemedicine" },
  { label: "RTC",          value: "rtc",          category: "behavior.rtc" },
  { label: "Logistics",    value: "logistics",    category: "behavior.logistics" },
];

export default function SystemBehaviorPage() {
  const { toasts, dismiss, success: toastSuccess, error: toastError } = useToast();

  const { categorySettings, isLoading, error, loadSettingsByCategory, saveSetting, clearError } =
    useAdminSettingsStore();

  const [activeTab, setActiveTab] = useState<Tab>("telemedicine");
  const [savingKey, setSavingKey] = useState<string | null>(null);

  /* ── Load active tab's category ── */
  useEffect(() => {
    const cat = TABS.find((t) => t.value === activeTab)!.category;
    loadSettingsByCategory(cat);
  }, [activeTab, loadSettingsByCategory]);

  /* ── Bubble store errors ── */
  useEffect(() => {
    if (error) { toastError("Failed to save", error); clearError(); }
  }, [error, clearError, toastError]);

  /* ── Generic save helper ── */
  const save = useCallback(
    async (key: string, value: unknown) => {
      const cat = TABS.find((t) => t.value === activeTab)!.category;
      setSavingKey(key);
      try {
        await saveSetting(cat, key, value);
        toastSuccess("Setting updated", `"${key.replaceAll("_", " ")}" has been saved.`);
      } finally {
        setSavingKey(null);
      }
    },
    [activeTab, saveSetting, toastSuccess],
  );

  if (isLoading && categorySettings.length === 0) {
    return (
      <div className="bg-card rounded-xl border border-border p-10 flex items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-[14px] font-poppins">Loading settings…</span>
      </div>
    );
  }

  return (
    <>
      <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-5">
        {/* Header + tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">System Behavior</h2>
          <div className="flex items-center gap-1 overflow-x-auto">
            {TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setActiveTab(tab.value)}
                className={`shrink-0 px-4 py-2 text-[13px] font-poppins transition-all duration-150 border-b-2 ${
                  activeTab === tab.value
                    ? "border-primary text-primary font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <WarningBanner />

        {activeTab === "telemedicine" && (
          <TelemedicineTab settings={categorySettings} save={save} savingKey={savingKey} />
        )}
        {activeTab === "rtc" && (
          <RTCTab settings={categorySettings} save={save} savingKey={savingKey} />
        )}
        {activeTab === "logistics" && (
          <LogisticsTab settings={categorySettings} save={save} savingKey={savingKey} />
        )}
      </div>

      <Toaster toasts={toasts} dismiss={dismiss} />
    </>
  );
}