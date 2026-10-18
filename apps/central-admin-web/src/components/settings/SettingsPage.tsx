"use client";

import { useRouter, useSearchParams } from "next/navigation";
import SettingsSubNav, { type SettingsSection } from "@/components/settings/SettingsSubNav";
import AccountSecurityPage from "@/components/settings/account-security/AccountSecurityPage";
import NotificationSettingsPage from "@/components/settings/notification-settings/NotificationSettingsPage";
import SystemBehaviorPage from "@/components/settings/system-behavior/SystemBehaviorPage";
import SecuritySettingsPage from "@/components/settings/security-settings/SecuritySettingsPage";
import SystemLimitsPage from "@/components/settings/system-limits/SystemLimitsPage";

const TAB_TO_SECTION: Record<string, SettingsSection> = {
  "Account Security":      "account-security",
  "Notification Settings": "notification-settings",
  "System Behavior":       "system-behavior",
  "Security Settings":     "security-settings",
  "System Limits":         "system-limits",
};

const SECTION_TO_TAB: Record<SettingsSection, string> = {
  "account-security":      "Account Security",
  "notification-settings": "Notification Settings",
  "system-behavior":       "System Behavior",
  "security-settings":     "Security Settings",
  "system-limits":         "System Limits",
};

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tabParam = searchParams.get("tab");
  const activeSection: SettingsSection =
    tabParam && TAB_TO_SECTION[tabParam] ? TAB_TO_SECTION[tabParam] : "account-security";

  const handleChange = (section: SettingsSection) => {
    const tab = SECTION_TO_TAB[section];
    router.replace(`/dashboard/settings?tab=${encodeURIComponent(tab)}`, { scroll: false });
  };

  return (
    <div className="flex gap-4">
      {/* ── Desktop sub-nav ── */}
      <div className="hidden min-[1014px]:block w-[168px] shrink-0">
        <SettingsSubNav active={activeSection} onChange={handleChange} />
      </div>

      {/* ── Content ── */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* ── Mobile sub-nav ── */}
        <div className="min-[1014px]:hidden">
          <SettingsSubNav active={activeSection} onChange={handleChange} />
        </div>

        {/* ── Page heading ── */}
        <div>
          <h1 className="text-title text-foreground mb-1">
            {SECTION_TO_TAB[activeSection]}
          </h1>
        </div>

        {/* ── Section content ── */}
        {activeSection === "account-security"      && <AccountSecurityPage />}
        {activeSection === "notification-settings" && <NotificationSettingsPage />}
        {activeSection === "system-behavior"       && <SystemBehaviorPage />}
        {activeSection === "security-settings"     && <SecuritySettingsPage />}
        {activeSection === "system-limits"         && <SystemLimitsPage />}
      </div>
    </div>
  );
}