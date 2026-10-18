import React from "react";

export type HealthnetSection =
  | "dashboard"
  | "appointments"
  | "patients"
  | "doctors"
  | "labs"
  | "pharmacy"
  | "vendors"
  | "analytics"
  | "finance"
  | "support"
  | "settings";

const navItems: { label: string; value: HealthnetSection }[] = [
  { label: "Dashboard",    value: "dashboard" },
  { label: "Appointments", value: "appointments" },
  { label: "Patients",     value: "patients" },
  { label: "Doctors",      value: "doctors" },
  { label: "Labs",         value: "labs" },
  { label: "Pharmacy",     value: "pharmacy" },
  { label: "Vendors",      value: "vendors" },
  { label: "Analytics",    value: "analytics" },
  { label: "Finance",      value: "finance" },
  { label: "Support",      value: "support" },
  { label: "Settings",     value: "settings" },
];

function NavItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-[8px] w-full text-left transition-all duration-150 ${
        active
          ? "bg-primary/8 text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
          active ? "bg-primary" : "bg-transparent"
        }`}
      />
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

export default function HealthnetSubNav({
  active,
  onChange,
}: {
  active: HealthnetSection;
  onChange: (s: HealthnetSection) => void;
}) {
  return (
    <>
      {/* Desktop — vertical sidebar */}
      <div className="hidden min-[1014px]:flex flex-col gap-0.5 w-[168px] shrink-0 pt-1">
        <SectionLabel label="Healthnet" />
        {navItems.map((item) => (
          <NavItem
            key={item.value}
            label={item.label}
            active={active === item.value}
            onClick={() => onChange(item.value)}
          />
        ))}
      </div>

      {/* Mobile — horizontal scroll */}
      <div className="flex min-[1014px]:hidden flex-col gap-2 pb-1">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
          <span className="text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/60 shrink-0 pr-1">
            Healthnet
          </span>
          {navItems.map((item) => (
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
      </div>
    </>
  );
}