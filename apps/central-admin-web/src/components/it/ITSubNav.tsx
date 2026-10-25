"use client";

export type ITSection =
  | "overview"
  | "telemedicine"
  | "rtc"
  | "logistics"
  | "payments"
  | "audit"
  | "notifications"
  | "services"
  | "jobs"
  | "dead-letters"
  | "webhooks"
  | "webhook-logs"
  | "incidents"
  | "alerts"
  | "flags"
  | "health"
  | "env-configs"
  | "mail-admin";

const opsItems: { label: string; value: ITSection }[] = [
  { label: "Overview",        value: "overview" },
  { label: "Telemedicine",    value: "telemedicine" },
  { label: "RTC Sessions",    value: "rtc" },
  { label: "Logistics",       value: "logistics" },
  { label: "Payments",        value: "payments" },
  { label: "Audit Logs",      value: "audit" },
  { label: "Notifications",   value: "notifications" },
];

const infraItems: { label: string; value: ITSection }[] = [
  { label: "Service Registry", value: "services" },
  { label: "Job Monitor",      value: "jobs" },
  { label: "Dead Letters",     value: "dead-letters" },
  { label: "Webhooks",         value: "webhooks" },
  { label: "Webhook Logs",     value: "webhook-logs" },
  { label: "Incidents",        value: "incidents" },
  { label: "Alerts",           value: "alerts" },
  { label: "Feature Flags",    value: "flags" },
  { label: "Health History",   value: "health" },
  { label: "Env Configs",      value: "env-configs" },
  { label: "Mail Administration", value: "mail-admin" },
];

function NavItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-[8px] w-full text-left transition-all duration-150 ${
        active
          ? "bg-primary/8 text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${active ? "bg-primary" : "bg-transparent"}`} />
      <span className="text-[13px] font-poppins">{label}</span>
    </button>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <span className="px-3 pt-3 pb-1 text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/60 select-none">
      {label}
    </span>
  );
}

const scrollRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  overflowX: "auto",
  paddingBottom: "2px",
  scrollbarWidth: "none",
  msOverflowStyle: "none",
};

function MobileScrollRow({ label, items, active, onChange }: {
  label: string;
  items: { label: string; value: ITSection }[];
  active: ITSection;
  onChange: (s: ITSection) => void;
}) {
  return (
    <div style={scrollRowStyle}>
      <span className="text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/60 shrink-0 pr-1">
        {label}
      </span>
      {items.map((item) => (
        <button
          key={item.value}
          onClick={() => onChange(item.value)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] whitespace-nowrap shrink-0 transition-all duration-150 text-[12px] font-poppins border ${
            active === item.value
              ? "bg-primary text-white border-primary font-semibold"
              : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export default function ITSubNav({
  active,
  onChange,
}: {
  active: ITSection;
  onChange: (s: ITSection) => void;
}) {
  return (
    <>
      {/* Desktop — vertical sidebar */}
      <div className="hidden min-[1014px]:flex flex-col gap-0.5 w-[168px] shrink-0 pt-1">
        <SectionLabel label="Operations" />
        {opsItems.map((item) => (
          <NavItem key={item.value} label={item.label} active={active === item.value} onClick={() => onChange(item.value)} />
        ))}

        <div className="mx-3 my-2 border-t border-border/60" />

        <SectionLabel label="Infrastructure" />
        {infraItems.map((item) => (
          <NavItem key={item.value} label={item.label} active={active === item.value} onClick={() => onChange(item.value)} />
        ))}
      </div>

      {/* Mobile — horizontal scroll */}
      <div className="flex min-[1014px]:hidden flex-col gap-2 pb-1">
        <MobileScrollRow label="Ops"   items={opsItems}   active={active} onChange={onChange} />
        <MobileScrollRow label="Infra" items={infraItems} active={active} onChange={onChange} />
      </div>
    </>
  );
}