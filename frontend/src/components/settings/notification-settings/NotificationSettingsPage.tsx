"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, CheckCircle2, XCircle, X } from "lucide-react";
import { useAdminSettingsStore } from "@/stores/admin-settings.store";
import type { ChannelToggleValue } from "@/types/admin-settings.types";

/* ─── Toast (inline) ──────────────────────────────────────── */
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

  const success = useCallback((title: string, message: string) => show("success", title, message), [show]);
  const error   = useCallback((title: string, message: string) => show("error",   title, message), [show]);

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

/* ─── Types ───────────────────────────────────────────────── */
type ToggleState = ChannelToggleValue;

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

/* ─── Triple toggle row ───────────────────────────────────── */
function TripleToggleRow({ state, onChange }: { state: ToggleState; onChange: (next: ToggleState) => void }) {
  const items = [
    { key: "email" as const,  label: "Email Notifications",  sub: "Enable all email notifications" },
    { key: "sms" as const,    label: "SMS Notifications",    sub: "Enable all SMS notifications" },
    { key: "inApp" as const,  label: "In-App Notifications", sub: "Enable all in-app notifications" },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {items.map(({ key, label, sub }) => (
        <div key={key} className="flex items-start justify-between gap-3 bg-muted/40 rounded-lg px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-poppins font-medium text-foreground">{label}</span>
            <span className="text-[11px] font-poppins text-muted-foreground">{sub}</span>
          </div>
          <Toggle checked={state[key]} onChange={(v) => onChange({ ...state, [key]: v })} />
        </div>
      ))}
    </div>
  );
}

/* ─── Single toggle item ──────────────────────────────────── */
function SingleToggleItem({
  label, sub, checked, onChange,
}: { label: string; sub: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3 bg-muted/40 rounded-lg px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-poppins font-medium text-foreground">{label}</span>
        <span className="text-[11px] font-poppins text-muted-foreground">{sub}</span>
      </div>
      <Toggle checked={checked} onChange={onChange} />
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

/* ─── Localization select ─────────────────────────────────── */
function LocalizationSelect({
  label, options, value, onChange,
}: { label: string; options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-poppins text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[38px] px-3 bg-muted border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
      >
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  );
}

/* ─── Default state factories ─────────────────────────────── */
const defaultToggle = (): ToggleState => ({ email: false, sms: false, inApp: false });

/* ─── Main ────────────────────────────────────────────────── */
export default function NotificationSettingsPage() {
  const { toasts, dismiss, success: toastSuccess, error: toastError } = useToast();

  const {
    allSettings,
    isLoading,
    isSaving,
    error,
    loadAllSettings,
    saveMultipleSettings,
    clearError,
  } = useAdminSettingsStore();

  /* ── Notification state ── */
  const [userAccount,    setUserAccount]    = useState<ToggleState>(defaultToggle);
  const [globalSys,      setGlobalSys]      = useState<ToggleState>(defaultToggle);
  const [newUser,        setNewUser]        = useState<ToggleState>(defaultToggle);
  const [telemedicine,   setTelemedicine]   = useState<ToggleState>(defaultToggle);
  const [consultations,  setConsultations]  = useState<ToggleState>(defaultToggle);
  const [logisticsOrders,setLogisticsOrders]= useState<ToggleState>(defaultToggle);
  const [logisticsAll,   setLogisticsAll]   = useState<ToggleState>(defaultToggle);
  const [payments,       setPayments]       = useState<ToggleState>(defaultToggle);
  const [paymentsGateway,setPaymentsGateway]= useState(false);
  const [paymentFailed,  setPaymentFailed]  = useState<ToggleState>(defaultToggle);
  const [lab,            setLab]            = useState<ToggleState>(defaultToggle);
  const [prescriptions,  setPrescriptions]  = useState<ToggleState>(defaultToggle);
  const [sysMaintenance, setSysMaintenance] = useState<ToggleState>(defaultToggle);
  const [securityAlerts, setSecurityAlerts] = useState<ToggleState>(defaultToggle);

  /* ── Telemedicine sub-toggles ── */
  const [telemedicineSubs, setTelemedicineSubs] = useState({
    teleconsultations: false,
    labOrders: false,
    pharmacyOrders: false,
    appointments: false,
    prescriptions: false,
    healthRecords: false,
  });
  const setTeleSub = (key: keyof typeof telemedicineSubs) => (v: boolean) =>
    setTelemedicineSubs((p) => ({ ...p, [key]: v }));

  /* ── System config (local-only — not in admin-settings API) ── */
  const [sysConfig, setSysConfig] = useState({
    maintenance: false,
    ssl: false,
    debug: false,
    twoFactor: false,
    autoBackup: false,
    activityLogging: false,
  });
  const setSys = (key: keyof typeof sysConfig) => (v: boolean) =>
    setSysConfig((p) => ({ ...p, [key]: v }));

  /* ── Localization state ── */
  const [currency, setCurrency] = useState("NGN");
  const [language, setLanguage] = useState("en");
  const [timezone, setTimezone] = useState("Africa/Lagos");

  /* ── Load all settings once — avoids the overwrite bug ── */
  useEffect(() => {
    loadAllSettings();
  }, [loadAllSettings]);

  /* ── Hydrate local state from allSettings ── */
  useEffect(() => {
    if (!allSettings) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const n = allSettings["notification"] ?? [];
    const l = allSettings["localization"] ?? [];

    const get = (arr: typeof n, key: string) => arr.find((s) => s.key === key)?.value;

    const maybeToggle = (v: any): ToggleState | null =>
      v && typeof v === "object" && "email" in v ? v : null;

    setUserAccount(    maybeToggle(get(n, "user_account"))          ?? defaultToggle());
    setGlobalSys(      maybeToggle(get(n, "global_system"))         ?? defaultToggle());
    setNewUser(        maybeToggle(get(n, "new_user_registration"))  ?? defaultToggle());
    setTelemedicine(   maybeToggle(get(n, "telemedicine"))          ?? defaultToggle());
    setConsultations(  maybeToggle(get(n, "consultations"))         ?? defaultToggle());
    setLogisticsOrders(maybeToggle(get(n, "logistics_orders"))      ?? defaultToggle());
    setLogisticsAll(   maybeToggle(get(n, "logistics_all"))         ?? defaultToggle());
    setPayments(       maybeToggle(get(n, "payments"))              ?? defaultToggle());
    setPaymentFailed(  maybeToggle(get(n, "payment_failed"))        ?? defaultToggle());
    setLab(            maybeToggle(get(n, "lab_tests"))             ?? defaultToggle());
    setPrescriptions(  maybeToggle(get(n, "prescriptions"))         ?? defaultToggle());
    setSysMaintenance( maybeToggle(get(n, "system_maintenance"))    ?? defaultToggle());
    setSecurityAlerts( maybeToggle(get(n, "security_alerts"))       ?? defaultToggle());

    const gw = get(n, "payment_gateway");
    if (gw?.enabled !== undefined) setPaymentsGateway(Boolean(gw.enabled));

    // Localization
    const cur = get(l, "default_currency");
    const lang = get(l, "default_language");
    const tz   = get(l, "default_timezone");
    if (cur)  setCurrency(String(cur));
    if (lang) setLanguage(String(lang));
    if (tz)   setTimezone(String(tz));
    });
    return () => { cancelled = true; };
  }, [allSettings]);

  /* ── Bubble store errors to toast ── */
  useEffect(() => {
    if (error) {
      toastError("Failed to save", error);
      clearError();
    }
  }, [error, clearError]);

  /* ── Save all ── */
  const handleSaveAll = useCallback(async () => {
    try {
      await saveMultipleSettings([
        { category: "notification", key: "user_account",          value: userAccount },
        { category: "notification", key: "global_system",         value: globalSys },
        { category: "notification", key: "new_user_registration", value: newUser },
        { category: "notification", key: "telemedicine",          value: telemedicine },
        { category: "notification", key: "consultations",         value: consultations },
        { category: "notification", key: "logistics_orders",      value: logisticsOrders },
        { category: "notification", key: "logistics_all",         value: logisticsAll },
        { category: "notification", key: "payments",              value: payments },
        { category: "notification", key: "payment_gateway",       value: { enabled: paymentsGateway } },
        { category: "notification", key: "payment_failed",        value: paymentFailed },
        { category: "notification", key: "lab_tests",             value: lab },
        { category: "notification", key: "prescriptions",         value: prescriptions },
        { category: "notification", key: "system_maintenance",    value: sysMaintenance },
        { category: "notification", key: "security_alerts",       value: securityAlerts },
        { category: "localization", key: "default_currency",      value: currency },
        { category: "localization", key: "default_language",      value: language },
        { category: "localization", key: "default_timezone",      value: timezone },
      ]);
      toastSuccess("Settings saved", "All notification settings have been updated.");
    } catch {
      // error toast handled via store error effect
    }
  }, [
    saveMultipleSettings,
    userAccount, globalSys, newUser, telemedicine, consultations,
    logisticsOrders, logisticsAll, payments, paymentsGateway, paymentFailed,
    lab, prescriptions, sysMaintenance, securityAlerts,
    currency, language, timezone, toastSuccess,
  ]);

  if (isLoading && !allSettings) {
    return (
      <div className="bg-card rounded-xl border border-border p-10 flex items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-[14px] font-poppins">Loading notification settings…</span>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-5 pb-24">
        <Section title="User Account Notification Preferences">
          <TripleToggleRow state={userAccount} onChange={setUserAccount} />
        </Section>

        <Section title="Localization Settings">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <LocalizationSelect label="Default Currency" options={["USD", "EUR", "GBP", "NGN"]} value={currency} onChange={setCurrency} />
            <LocalizationSelect label="Default Language" options={["en", "fr", "es", "ar"]} value={language} onChange={setLanguage} />
            <LocalizationSelect
              label="Default Timezone"
              options={["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Africa/Lagos", "UTC"]}
              value={timezone}
              onChange={setTimezone}
            />
          </div>
        </Section>

        <Section title="System Configuration">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <SingleToggleItem label="Maintenance Mode"         sub="Temporarily disable public access"       checked={sysConfig.maintenance}     onChange={setSys("maintenance")} />
            <SingleToggleItem label="SSL Enforcement"          sub="Force HTTPS connections"                 checked={sysConfig.ssl}             onChange={setSys("ssl")} />
            <SingleToggleItem label="Debug Mode"               sub="Enable detailed error logging"           checked={sysConfig.debug}           onChange={setSys("debug")} />
            <SingleToggleItem label="Two Factor Authentication" sub="Prevent API abuse"                      checked={sysConfig.twoFactor}       onChange={setSys("twoFactor")} />
            <SingleToggleItem label="Auto Back Ups"            sub="Automatic daily system backups"          checked={sysConfig.autoBackup}      onChange={setSys("autoBackup")} />
            <SingleToggleItem label="Activity Logging"         sub="Log user activity for audit"             checked={sysConfig.activityLogging} onChange={setSys("activityLogging")} />
          </div>
        </Section>

        <div className="border-t border-border" />

        <Section title="Global System Configuration">
          <TripleToggleRow state={globalSys} onChange={setGlobalSys} />
        </Section>

        <Section title="New User Registration">
          <TripleToggleRow state={newUser} onChange={setNewUser} />
        </Section>

        <Section title="All Telemedicine Activities">
          <TripleToggleRow state={telemedicine} onChange={setTelemedicine} />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <SingleToggleItem label="Teleconsultations"       sub="Enable video consultations between doctors and patients" checked={telemedicineSubs.teleconsultations} onChange={setTeleSub("teleconsultations")} />
            <SingleToggleItem label="Lab Orders"              sub="Allow patients to book laboratory tests online"          checked={telemedicineSubs.labOrders}         onChange={setTeleSub("labOrders")} />
            <SingleToggleItem label="Pharmacy Orders"         sub="Enable online pharmacy ordering and delivery"            checked={telemedicineSubs.pharmacyOrders}    onChange={setTeleSub("pharmacyOrders")} />
            <SingleToggleItem label="Appointments Scheduling" sub="In-person appointment booking system"                   checked={telemedicineSubs.appointments}      onChange={setTeleSub("appointments")} />
            <SingleToggleItem label="Prescription Management" sub="Digital prescription creation and management"           checked={telemedicineSubs.prescriptions}     onChange={setTeleSub("prescriptions")} />
            <SingleToggleItem label="Health Records"          sub="Patient health record storage and sharing"              checked={telemedicineSubs.healthRecords}     onChange={setTeleSub("healthRecords")} />
          </div>
        </Section>

        <Section title="Consultations">
          <TripleToggleRow state={consultations} onChange={setConsultations} />
        </Section>

        <Section title="Logistics Orders">
          <TripleToggleRow state={logisticsOrders} onChange={setLogisticsOrders} />
        </Section>

        <Section title="All Logistics Activities">
          <TripleToggleRow state={logisticsAll} onChange={setLogisticsAll} />
        </Section>

        <Section title="Payments">
          <TripleToggleRow state={payments} onChange={setPayments} />
          <SingleToggleItem label="Payments Gateway" sub="Enable payment gateway integration" checked={paymentsGateway} onChange={setPaymentsGateway} />
        </Section>

        <Section title="Payment Failed">
          <TripleToggleRow state={paymentFailed} onChange={setPaymentFailed} />
        </Section>

        <Section title="Lab / Test Activities">
          <TripleToggleRow state={lab} onChange={setLab} />
        </Section>

        <Section title="Prescriptions Activities">
          <TripleToggleRow state={prescriptions} onChange={setPrescriptions} />
        </Section>

        <Section title="System based maintenance">
          <TripleToggleRow state={sysMaintenance} onChange={setSysMaintenance} />
        </Section>

        <Section title="Security Alerts">
          <TripleToggleRow state={securityAlerts} onChange={setSecurityAlerts} />
        </Section>

        {/* Save button */}
        <div className="fixed bottom-6 right-6">
          <button
            type="button"
            onClick={handleSaveAll}
            disabled={isSaving}
            className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-lg font-poppins font-semibold shadow-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            {isSaving ? "Saving…" : "Save All Settings"}
          </button>
        </div>
      </div>

      <Toaster toasts={toasts} dismiss={dismiss} />
    </>
  );
}