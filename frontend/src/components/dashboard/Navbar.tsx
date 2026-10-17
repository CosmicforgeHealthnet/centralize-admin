"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { Bell, Menu, Search, X, Maximize2, Check, AlertCircle, XCircle, Settings, Bell as BellIcon, Sun, Moon } from "lucide-react";
import Image from "next/image";
import { useAuthStore } from "@/stores/auth.store";
import { useProfileStore } from "@/stores/profile.store";
import { useNotificationStore } from "@/stores/notification.store";

const breadcrumbs: Record<string, { parent: string; current: string }> = {
  "/dashboard": { parent: "", current: "Dashboard" },
  "/dashboard/help": { parent: "Support", current: "Overview" },
  "/dashboard/help/tickets": { parent: "Support", current: "Tickets" },
  "/dashboard/help/live-chat": { parent: "Support / Live Chat", current: "Active Conversations" },
  "/dashboard/help/email": { parent: "Support", current: "Email Support" },
  "/dashboard/help/email/channel": { parent: "Support / Email Support", current: "Support Channel" },
  "/dashboard/hr": { parent: "HR", current: "Overview" },
  "/dashboard/it": { parent: "I.T", current: "Overview" },
  "/dashboard/finance": { parent: "Finance", current: "Overview" },
  "/dashboard/marketing": { parent: "Marketing", current: "Overview" },
  "/dashboard/analytics": { parent: "Analytics", current: "Overview" },
  "/dashboard/settings": { parent: "Settings", current: "Account Security" },
  "/dashboard/settings?tab=Account+Security": { parent: "Settings", current: "Account Security" },
  "/dashboard/settings?tab=Notification+Settings": { parent: "Settings", current: "Notification Settings" },
  "/dashboard/settings?tab=System+Behavior": { parent: "Settings", current: "System Behavior" },
  "/dashboard/settings?tab=Security+Settings": { parent: "Settings", current: "Security Settings" },
  "/dashboard/settings?tab=System+Limits": { parent: "Settings", current: "System Limits" },
  "/dashboard/profile": { parent: "Profile", current: "Profile Info" },
  "/dashboard/profile?tab=Profile+Info": { parent: "Profile", current: "Profile Info" },
  "/dashboard/profile?tab=Documents": { parent: "Profile", current: "Documents" },
  "/dashboard/profile?tab=Projects": { parent: "Profile", current: "Projects" },
  "/dashboard/profile?tab=Tasks": { parent: "Profile", current: "Tasks" },
  "/dashboard/profile?tab=Teams": { parent: "Profile", current: "Teams" },
  "/dashboard/profile?tab=Activity+Logs": { parent: "Profile", current: "Activity Logs" },
  "/dashboard/profile?tab=Notification": { parent: "Profile", current: "Notification" },
};

const getCrumb = (pathname: string, search: string) => {
  const full = search ? `${pathname}${search}` : pathname;
  if (breadcrumbs[full]) return breadcrumbs[full];
  if (breadcrumbs[pathname]) return breadcrumbs[pathname];
  if (pathname.startsWith("/dashboard/help/tickets/"))
    return { parent: "Support / Tickets", current: "Active Conversations" };
  return { parent: "", current: "Dashboard" };
};

const getGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
};

const parentSegmentHref = (segment: string): string => {
  const map: Record<string, string> = {
    "Support": "/dashboard/help",
    "Live Chat": "/dashboard/help/live-chat",
    "Email Support": "/dashboard/help/email",
    "Tickets": "/dashboard/help/tickets",
    "HR": "/dashboard/hr",
    "I.T": "/dashboard/it",
    "Finance": "/dashboard/finance",
    "Marketing": "/dashboard/marketing",
    "Analytics": "/dashboard/analytics",
    "Settings": "/dashboard/settings",
    "Profile": "/dashboard/profile",
    "Dashboard": "/dashboard",
  };
  return map[segment] ?? "/dashboard";
};

function NotifIconBox({ type }: { type: string }) {
  const iconProps = { size: 16, strokeWidth: 1.5, className: "text-[#6B7280]" };
  const iconMap: Record<string, React.ReactNode> = {
    alert: <AlertCircle {...iconProps} />,
    xcircle: <XCircle {...iconProps} />,
    settings: <Settings {...iconProps} />,
    check: <Check {...iconProps} />,
    bell: <BellIcon {...iconProps} />,
  };

  return (
    <div
      className="w-8 h-8 rounded-[6px] flex items-center justify-center shrink-0"
      style={{ backgroundColor: "#F3F4F6" }}
    >
      {iconMap[type] || iconMap.bell}
    </div>
  );
}

function NotificationPanel({ onClose, onExpand }: { onClose: () => void; onExpand: () => void }) {
  const { groupedNotifications, isLoading, markAsRead, markAllAsRead, fetchNotifications } = useNotificationStore();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (isLoading) {
    return (
      <div
        ref={panelRef}
        className="absolute right-0 top-full mt-2 w-[320px] sm:w-[380px] bg-card rounded-[16px] shadow-lg z-50 p-4"
      >
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-muted rounded w-3/4"></div>
          <div className="h-10 bg-muted rounded"></div>
          <div className="h-10 bg-muted rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full mt-2 w-[320px] sm:w-[380px] bg-card rounded-[16px] z-50 flex flex-col"
      style={{
        boxShadow: "0px 8px 40px 0px rgba(0,0,0,0.12)",
        maxHeight: "min(560px, calc(100vh - 80px))",
      }}
    >
      <div className="px-4 sm:px-5 pt-4 sm:pt-5 pb-3 flex flex-col gap-1 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[14px] sm:text-[15px] font-poppins font-bold text-foreground">Notifications</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onExpand}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="View all notifications"
            >
              <Maximize2 size={15} />
            </button>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close notifications"
            >
              <X size={15} />
            </button>
          </div>
        </div>
        <p className="text-[11px] sm:text-[12px] font-poppins text-muted-foreground">Stay Updated with latest alerts</p>

        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-4">
            <button className="flex flex-col items-start gap-1 pb-1">
              <span className="text-[12px] sm:text-[13px] font-poppins font-semibold text-foreground">All</span>
              <div className="w-full h-[2px] bg-primary rounded-full" />
            </button>
          </div>
          <button
            onClick={markAllAsRead}
            className="flex items-center gap-1.5 text-[11px] sm:text-[12px] font-poppins text-muted-foreground hover:text-foreground transition-colors"
          >
            <Check size={13} strokeWidth={2} />
            <span className="hidden sm:inline">Mark all as read</span>
          </button>
        </div>
      </div>

      <div className="h-px bg-border mx-4 sm:mx-5 shrink-0" />

      <div className="overflow-y-auto flex-1 px-2 sm:px-3 pb-4">
        {groupedNotifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <BellIcon size={28} className="text-muted-foreground mb-2" />
            <p className="text-[12px] sm:text-[13px] font-poppins text-muted-foreground">No notifications yet</p>
          </div>
        ) : (
          groupedNotifications.map((group) => (
            <div key={group.date}>
              <div className="flex items-center justify-center py-3">
                <span className="text-[10px] sm:text-[11px] font-poppins text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  {group.date}
                </span>
              </div>

              {group.items.map((notif) => (
                <div
                  key={notif.id}
                  onClick={() => markAsRead(notif.id)}
                  className="flex items-start gap-2 sm:gap-3 py-2.5 px-2 rounded-[8px] hover:bg-muted/30 transition-colors cursor-pointer"
                >
                  <NotifIconBox type={notif.icon} />

                  <div className="flex-1 min-w-0">
                    <p className={`text-[11px] sm:text-[12px] font-poppins text-foreground leading-snug ${notif.bold ? "font-bold" : "font-normal"}`}>
                      {notif.title}
                    </p>
                    <p className="text-[10px] sm:text-[11px] font-poppins text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                      {notif.subtitle}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-1 shrink-0 min-w-[60px] sm:min-w-[70px]">
                    {notif.unread && <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-[#EF4444] shrink-0" />}
                    <span className="text-[9px] sm:text-[10px] font-poppins text-muted-foreground whitespace-nowrap text-right">
                      {notif.time}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = (dark: boolean) => {
    if (dark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    setIsDark(dark);
  };

  return (
    <div className="flex items-center bg-muted border border-border rounded-full p-[3px] gap-[2px]">
      <button
        onClick={() => toggle(false)}
        aria-label="Light mode"
        className={`w-[26px] h-[26px] rounded-full flex items-center justify-center transition-all duration-150 ${
          !isDark
            ? "bg-card border border-border text-foreground shadow-sm"
            : "bg-transparent text-muted-foreground hover:text-foreground"
        }`}
      >
        <Sun size={13} strokeWidth={1.8} />
      </button>
      <button
        onClick={() => toggle(true)}
        aria-label="Dark mode"
        className={`w-[26px] h-[26px] rounded-full flex items-center justify-center transition-all duration-150 ${
          isDark
            ? "bg-card border border-border text-foreground shadow-sm"
            : "bg-transparent text-muted-foreground hover:text-foreground"
        }`}
      >
        <Moon size={13} strokeWidth={1.8} />
      </button>
    </div>
  );
}

function NavbarInner({ onMenuClick }: { onMenuClick?: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const crumb = getCrumb(pathname, search);
  const { user } = useAuthStore();
  const { profile } = useProfileStore();
  const { unreadCount, fetchUnreadCount } = useNotificationStore();
  const router = useRouter();
  const [notifOpen, setNotifOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);

  const isOnNotificationsPage = searchParams.get("tab") === "Notification" && pathname === "/dashboard/profile";

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && notifOpen) setNotifOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [notifOpen]);

  const handleExpand = () => {
    setNotifOpen(false);
    setTimeout(() => router.push("/dashboard/profile?tab=Notification"), 50);
  };

  const handleBellClick = () => {
    if (!isOnNotificationsPage) setNotifOpen((prev) => !prev);
  };

  const avatarSrc = profile?.avatarUrl || null;
  const userInitial = user?.name?.charAt(0).toUpperCase() ?? "A";

  return (
    <div
      className="flex items-center justify-between px-4 md:px-6 py-3 bg-muted sticky top-0 z-40"
      style={{ boxShadow: "1px 1px 40.7px 0px #0000001A" }}
    >
      {/* Left — breadcrumb */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <button
          onClick={onMenuClick}
          className="md:hidden w-8 h-8 flex items-center justify-center rounded-full bg-card border border-border shrink-0"
          aria-label="Menu"
        >
          <Menu className="w-4 h-4 text-foreground" />
        </button>

        <div className="flex items-center gap-1 min-w-0 overflow-hidden">
          {crumb.parent && (
            <>
              <span className="hidden sm:flex items-center gap-1 shrink-0">
                {crumb.parent.split(" / ").map((segment, i, arr) => (
                  <span key={i} className="flex items-center gap-1">
                    <button
                      onClick={() => router.push(parentSegmentHref(segment))}
                      className="text-[13px] sm:text-[14px] font-sans text-muted-foreground hover:text-foreground hover:underline transition-colors"
                    >
                      {segment}
                    </button>
                    {i < arr.length - 1 && (
                      <span className="text-[13px] sm:text-[14px] font-sans text-muted-foreground mx-0.5 sm:mx-1">/</span>
                    )}
                  </span>
                ))}
                <span className="text-[13px] sm:text-[14px] font-sans text-muted-foreground mx-0.5 sm:mx-1">/</span>
              </span>

              <span className="flex sm:hidden items-center gap-1 shrink-0">
                <button
                  onClick={() => router.push(parentSegmentHref(crumb.parent.split(" / ").at(-1)!))}
                  className="text-[12px] sm:text-[13px] font-sans text-muted-foreground truncate max-w-[60px] hover:text-foreground hover:underline"
                >
                  {crumb.parent.split(" / ").at(-1)}
                </button>
                <span className="text-[12px] sm:text-[13px] font-sans text-muted-foreground mx-0.5">/</span>
              </span>
            </>
          )}

          <span className="text-[12px] sm:text-[14px] font-sans font-bold text-foreground truncate">
            {crumb.current}
          </span>
        </div>
      </div>

      {/* Center — search */}
      <div className="hidden md:flex items-center gap-2 bg-card border border-border rounded-md px-3 h-[36px] w-[240px] lg:w-[280px] shrink-0 mx-4">
        <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    <input
  type="text"
  placeholder="Search here..."
  autoComplete="one-time-code"
  className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
/>
      </div>

      {/* Right — actions */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">

        {/* Theme toggle */}
        <ThemeToggle />

        {/* Notifications */}
        <div className="relative">
          <button
            ref={bellRef}
            onClick={handleBellClick}
            className={`w-8 h-8 flex items-center justify-center relative rounded-full transition-colors ${
              isOnNotificationsPage ? "cursor-default opacity-50" : "hover:bg-card"
            }`}
            aria-label="Notifications"
            disabled={isOnNotificationsPage}
          >
            <Bell className="w-4 h-4 sm:w-5 sm:h-5 text-foreground" />
            {unreadCount > 0 && !isOnNotificationsPage && (
              <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-red-500" />
            )}
          </button>

          {notifOpen && !isOnNotificationsPage && (
            <NotificationPanel
              onClose={() => setNotifOpen(false)}
              onExpand={handleExpand}
            />
          )}
        </div>

        {/* Profile */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-primary flex items-center justify-center overflow-hidden shrink-0">
            {avatarSrc ? (
              <Image
                src={avatarSrc}
                alt={user?.name || "User avatar"}
                width={36}
                height={36}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-white text-xs sm:text-sm font-semibold font-poppins">
                {userInitial}
              </span>
            )}
          </div>
          <div className="hidden sm:flex flex-col">
  <span className="text-[10px] sm:text-[11px] font-poppins text-muted-foreground leading-tight">{getGreeting()}</span>
  <span className="text-[11px] sm:text-[12px] font-poppins font-bold text-primary dark:text-white leading-tight">{user?.name ?? "Admin"}</span>
</div>
        </div>

      </div>
    </div>
  );
}

export default function Navbar({ onMenuClick }: { onMenuClick?: () => void }) {
  return (
    <Suspense fallback={null}>
      <NavbarInner onMenuClick={onMenuClick} />
    </Suspense>
  );
}