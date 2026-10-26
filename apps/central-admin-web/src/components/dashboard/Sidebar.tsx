"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  HelpCircle,
  Users,
  Cloud,
  CreditCard,
  Megaphone,
  BarChart2,
  User,
  Settings,
  Cross,
  Gift,
  TrendingUp,
  LogOut,
  X,
  ChevronLeft,
  ChevronRight,
  Verified,
  Mail,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import api from "@/lib/api";
import { useAuthStore } from "@/stores/auth.store";
import { useProfileStore } from "@/stores/profile.store";
import { useEntitlements } from "@/components/mail/hooks";

// Who sees what. ADMIN/EXECUTIVE/SUPER keep the full navigation. Everyone
// else sees personal pages, Mail (when entitled) and only the sections they
// hold an active section grant for. This is presentation only: every API
// enforces its own tier/section checks.
type NavAccess = "all" | "privileged" | { module: string };
interface NavItem {
  label: string;
  icon: LucideIcon;
  href: string;
  access: NavAccess;
}

const PRIVILEGED_TIERS = new Set(["SUPER", "EXECUTIVE", "ADMIN"]);

const MAIL_NAV_ITEM: NavItem = { label: "Mail", icon: Mail, href: "/dashboard/mail", access: "all" };

const navItems: NavItem[] = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/dashboard", access: "all" },
  { label: "User Management", icon: Users, href: "/dashboard/users", access: "privileged" },
  { label: "Help & Support", icon: HelpCircle, href: "/dashboard/help", access: { module: "support" } },
  { label: "Human Resources", icon: Users, href: "/dashboard/hr", access: { module: "hrm" } },
  { label: "I.T and System", icon: Cloud, href: "/dashboard/it", access: "privileged" },
  { label: "Finance", icon: CreditCard, href: "/dashboard/finance", access: { module: "finance" } },
  { label: "Marketing", icon: Megaphone, href: "/dashboard/marketing", access: { module: "marketing" } },
  { label: "Analytics", icon: BarChart2, href: "/dashboard/analytics", access: "privileged" },
  { label: "Profile", icon: User, href: "/dashboard/profile", access: "all" },
  { label: "Verification", icon: Verified, href: "/dashboard/verification", access: { module: "verification" } },
  { label: "Settings", icon: Settings, href: "/dashboard/settings", access: "all" },
];

const productSuites: NavItem[] = [
  { label: "Healthnet", icon: Cross, href: "/dashboard/healthnet", access: "privileged" },
  { label: "Events Management", icon: Gift, href: "/dashboard/events", access: "privileged" },
  { label: "Trading Bot", icon: TrendingUp, href: "/dashboard/trading", access: "privileged" },
];

// Mail-backed pages outside /dashboard/mail that Mail entitlements open.
const MAIL_SUPPORT_PATH = "/dashboard/help/email";
const MAIL_MARKETING_PATH = "/dashboard/marketing/email-marketing";

interface MyGrants {
  tier: string;
  grants: { module: string; section: string; mode: string; expiresAt: string | null }[];
}

export interface NavPermissions {
  /** False until tier/grants/entitlements are known (employees only). */
  ready: boolean;
  privileged: boolean;
  modules: Set<string>;
  showMail: boolean;
  mailSupport: boolean;
  mailMarketing: boolean;
}

export function useNavPermissions(): NavPermissions {
  const user = useAuthStore((state) => state.user);
  const privileged = PRIVILEGED_TIERS.has(user?.tier ?? "");
  const grants = useQuery({
    queryKey: ["nav", "my-grants", user?.id ?? null],
    queryFn: async () => (await api.get<{ data: MyGrants | null }>("/api/hrm/accounts/me/grants")).data.data,
    enabled: !!user && !privileged,
    staleTime: 60_000,
    retry: false,
  });
  // Mail is shown only when the backend says this employee may use it.
  const ents = useEntitlements();
  const mail = ents.data;
  const mailEnabled = !!mail?.mailEnabled;
  const showMail =
    mailEnabled &&
    (mail.mailboxes.length > 0 ||
      !!mail.canViewAdministration ||
      mail.canManageDomains ||
      mail.canApproveProvisioning ||
      mail.canManageSharedMembership ||
      mail.marketing.length > 0);
  const modules = new Set((grants.data?.grants ?? []).map((grant) => grant.module));
  return {
    ready: privileged || (!!user && !grants.isLoading && !ents.isLoading),
    privileged,
    modules,
    showMail,
    mailSupport: mailEnabled && (mail?.mailboxes ?? []).some((mb) => mb.type === "SHARED" && mb.purpose === "SUPPORT"),
    mailMarketing: mailEnabled && (mail?.marketing.length ?? 0) > 0,
  };
}

function itemAllowed(item: NavItem, perms: NavPermissions) {
  if (perms.privileged || item.access === "all") return true;
  if (item.access === "privileged") return false;
  return perms.modules.has(item.access.module);
}

/** Navigation entries for this user; Mail-only access links to the Mail page. */
function visibleItems(items: NavItem[], perms: NavPermissions): NavItem[] {
  return items.flatMap((item) => {
    if (itemAllowed(item, perms)) return [item];
    if (item.href === "/dashboard/help" && perms.mailSupport) return [{ ...item, href: MAIL_SUPPORT_PATH }];
    if (item.href === "/dashboard/marketing" && perms.mailMarketing) return [{ ...item, href: MAIL_MARKETING_PATH }];
    return [];
  });
}

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** Used by the dashboard layout to keep employees out of other sections. */
export function isDashboardPathAllowed(pathname: string, perms: NavPermissions) {
  if (perms.privileged || pathname === "/dashboard") return true;
  if (under(pathname, MAIL_NAV_ITEM.href)) return true; // Mail pages check entitlements themselves.
  if (under(pathname, MAIL_SUPPORT_PATH)) return perms.mailSupport || perms.modules.has("support");
  if (under(pathname, MAIL_MARKETING_PATH)) return perms.mailMarketing || perms.modules.has("marketing");
  const item = [...navItems, ...productSuites].find((entry) => entry.href !== "/dashboard" && under(pathname, entry.href));
  return item ? itemAllowed(item, perms) : true;
}

export default function Sidebar({
  mobileOpen,
  onMobileClose,
  collapsed,
  onToggleCollapse,
}: {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { logout, user } = useAuthStore();
  const { profile } = useProfileStore();
  const perms = useNavPermissions();
  const allowedNavItems = visibleItems(navItems, perms);
  const visibleNavItems = perms.showMail
    ? [allowedNavItems[0], MAIL_NAV_ITEM, ...allowedNavItems.slice(1)]
    : allowedNavItems;
  const visibleSuites = visibleItems(productSuites, perms);

  const handleLogout = async () => {
    await logout();
    router.push("/");
  };

  const avatarSrc = profile?.avatarUrl || null;
  const userInitial = user?.name?.charAt(0).toUpperCase() ?? "A";

  return (
    <>
      <style>{`
        .sidebar {
          position: fixed;
          left: 0;
          top: 0;
          height: 100vh;
          width: var(--sw, 284px);
          z-index: 50;
          overflow: hidden;
          transition: width 300ms ease-in-out;
        }

        /* ---------- Collapse state (desktop only, CSS-driven) ---------- */
        .sidebar-label {
          transition: opacity 200ms ease-in-out, max-width 300ms ease-in-out;
          overflow: hidden;
          white-space: nowrap;
          opacity: 1;
          max-width: 200px;
        }
        .sidebar.is-collapsed .sidebar-label {
          opacity: 0;
          max-width: 0px;
        }
        .sidebar-row {
          justify-content: flex-start;
        }
        .sidebar.is-collapsed .sidebar-row {
          justify-content: center;
        }
        .sidebar-logo-wrap {
          display: block;
        }
        .sidebar.is-collapsed .sidebar-logo-wrap {
          display: none;
        }
        .sidebar-suites-divider {
          display: none;
        }
        .sidebar-suites-title {
          display: block;
        }
        .sidebar.is-collapsed .sidebar-suites-divider {
          display: block;
        }
        .sidebar.is-collapsed .sidebar-suites-title {
          display: none;
        }

        /* ---------- Mobile: always a full drawer, never "collapsed" ---------- */
        @media (max-width: 767px) {
          .sidebar {
            width: 284px !important;
            transform: translateX(-100%);
            transition: transform 300ms ease-in-out;
          }
          .sidebar.mobile-open {
            transform: translateX(0);
          }
          .sidebar.is-collapsed .sidebar-label {
            opacity: 1 !important;
            max-width: 200px !important;
          }
          .sidebar.is-collapsed .sidebar-row {
            justify-content: flex-start !important;
          }
          .sidebar.is-collapsed .sidebar-logo-wrap {
            display: block !important;
          }
          .sidebar.is-collapsed .sidebar-suites-divider {
            display: none !important;
          }
          .sidebar.is-collapsed .sidebar-suites-title {
            display: block !important;
          }
        }

        /* Collapse toggle: only show above 1116px */
        .sidebar-collapse-btn {
          display: flex;
        }
        @media (max-width: 1116px) {
          .sidebar-collapse-btn {
            display: none !important;
          }
        }

        /* Logo: hidden between 768px–1115px (tablet icon-only mode)
           but visible on desktop (≥1116px, unless collapsed)
           and visible on mobile (<768px, always drawer = full width) */
        @media (min-width: 768px) and (max-width: 1115px) {
          .sidebar-logo-wrap {
            display: none !important;
          }
        }
      `}</style>

      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 md:hidden"
          onClick={onMobileClose}
        />
      )}

      <div
        className={`sidebar ${mobileOpen ? "mobile-open" : ""} ${
          collapsed ? "is-collapsed" : ""
        }`}
      >
        {/* White base */}
        <div className="absolute inset-0 bg-white rounded-tr-[50px] rounded-br-[50px] shadow-[1px_1px_40.7px_0px_#0000001A]" />

        {/* Logo — hidden on tablet, hidden when desktop collapsed, always shown on mobile */}
        <div className="sidebar-logo-wrap absolute left-[44.5px] top-[18px] z-10">
          <Image
            src="/logo.svg"
            alt="Cosmicforge Healthnet Logo"
            width={155}
            height={45}
            className="object-contain"
          />
        </div>

        {/* Mobile close button */}
        <button
          onClick={onMobileClose}
          className="md:hidden absolute top-4 right-4 z-20 w-8 h-8 flex items-center justify-center rounded-full bg-black/10"
          aria-label="Close sidebar"
        >
          <X className="w-5 h-5 text-gray-600" />
        </button>

        {/* Blue shape + nav */}
        <div className="absolute left-0 right-0 bottom-0 overflow-hidden" style={{ top: "55px" }}>
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 284 969"
            preserveAspectRatio="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M0 0L38.1263 39.2816C45.5167 46.896 55.1379 51.9617 65.5979 53.7459L267.363 88.1621C276.972 89.8012 284 98.1293 284 107.877V949.5C284 960.546 275.046 969.5 264 969.5H83.5H0V0Z"
              fill="#272EA7"
            />
          </svg>

          <div
            className="relative z-10 flex flex-col h-full py-6 overflow-y-auto"
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          >
            {/* Nav Items */}
            <nav className="flex flex-col gap-1 mt-8 px-3">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const isActive =
                  item.href === MAIL_NAV_ITEM.href
                    ? pathname === item.href || pathname.startsWith(`${item.href}/`)
                    : pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onMobileClose}
                    title={collapsed ? item.label : undefined}
                    className={`sidebar-row flex items-center gap-3 px-3 py-2.5 rounded-[12px] transition-all duration-200 ${
                      isActive
                        ? "bg-white/20 text-white"
                        : "text-white hover:bg-white/10"
                    }`}
                  >
                    <Icon className="w-5 h-5 shrink-0 text-white" />
                    <span className="sidebar-label text-[14px] font-poppins font-semibold text-white">
                      {item.label}
                    </span>
                  </Link>
                );
              })}
            </nav>

            {/* Product Suites */}
            {visibleSuites.length > 0 && (
            <div className="mt-4 px-3">
              <div className="sidebar-suites-divider w-full h-[1px] bg-white/20 mb-3" />
              <p className="sidebar-suites-title text-[11px] font-poppins text-white/50 font-medium px-3 mb-2">
                Product Suites
              </p>
              <nav className="flex flex-col gap-1">
                {visibleSuites.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onMobileClose}
                      title={collapsed ? item.label : undefined}
                      className={`sidebar-row flex items-center gap-3 px-3 py-2.5 rounded-[12px] transition-all duration-200 ${
                        isActive
                          ? "bg-white/20 text-white"
                          : "text-white hover:bg-white/10"
                      }`}
                    >
                      <Icon className="w-5 h-5 shrink-0 text-white" />
                      <span className="sidebar-label text-[14px] font-poppins font-semibold text-white">
                        {item.label}
                      </span>
                    </Link>
                  );
                })}
              </nav>
            </div>
            )}

            <div className="flex-1" />

            {/* User Profile */}
            <div className="sidebar-row flex items-center gap-3 mx-3 px-3 py-3 rounded-[12px] bg-white/10 mb-3">
              <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center overflow-hidden shrink-0">
                {avatarSrc ? (
                  <Image
                    src={avatarSrc}
                    alt={user?.name || "User avatar"}
                    width={36}
                    height={36}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-white text-sm font-semibold font-poppins">
                    {userInitial}
                  </span>
                )}
              </div>
              <div className="sidebar-label flex flex-col min-w-0">
                <span className="text-[13px] font-poppins font-semibold text-white truncate">
                  {user?.name ?? "Admin"}
                </span>
                <span className="text-[11px] font-poppins text-white/60 capitalize">
                  {user?.tier?.toLowerCase() ?? ""}
                </span>
              </div>
            </div>

            {/* Log Out */}
            <button
              onClick={handleLogout}
              className="sidebar-row flex items-center gap-3 mx-3 px-3 py-3 rounded-[12px] hover:bg-white/10 transition-all duration-200"
              title={collapsed ? "Log Out" : undefined}
            >
              <LogOut className="w-5 h-5 text-red-400 shrink-0" />
              <span className="sidebar-label text-[14px] font-poppins font-semibold text-red-400">
                Log Out
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Collapse toggle — outside sidebar so overflow:hidden doesn't clip it */}
      <button
        onClick={onToggleCollapse}
        className="sidebar-collapse-btn fixed top-[80px] z-[51] w-6 h-6 rounded-full bg-white border border-gray-200 shadow-md items-center justify-center hover:bg-gray-50 transition-all duration-300"
        style={{ left: collapsed ? "calc(72px - 12px)" : "calc(284px - 12px)" }}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <ChevronRight className="w-3 h-3 text-gray-600" />
        ) : (
          <ChevronLeft className="w-3 h-3 text-gray-600" />
        )}
      </button>
    </>
  );
}