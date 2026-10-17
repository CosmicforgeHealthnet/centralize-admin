"use client";

export type SettingsSection =
  | "account-security"
  | "notification-settings"
  | "system-behavior"
  | "security-settings"
  | "system-limits";

const settingsItems: { label: string; value: SettingsSection }[] = [
  { label: "Account Security",      value: "account-security" },
  { label: "Notification Settings", value: "notification-settings" },
  { label: "System Behavior",       value: "system-behavior" },
  { label: "Security Settings",     value: "security-settings" },
  { label: "System Limits",         value: "system-limits" },
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
          ? "bg-primary/8 text-primary font-semibold"
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

export default function SettingsSubNav({
  active,
  onChange,
}: {
  active: SettingsSection;
  onChange: (s: SettingsSection) => void;
}) {
  return (
    <>
      {/* ── Desktop vertical sidebar ── */}
      <div className="hidden min-[1014px]:flex flex-col gap-0.5 w-[168px] shrink-0 pt-1">
        {settingsItems.map((item) => (
          <NavItem
            key={item.value}
            label={item.label}
            active={active === item.value}
            onClick={() => onChange(item.value)}
          />
        ))}
      </div>

      {/* ── Mobile horizontal scroll — scrollbar fully hidden ── */}
      <div
        className="flex min-[1014px]:hidden overflow-x-auto scrollbar-none pb-1 gap-1.5"
      >
        {settingsItems.map((item) => (
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
    </>
  );
}