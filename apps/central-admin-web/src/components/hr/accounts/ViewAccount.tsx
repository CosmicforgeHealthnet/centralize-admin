"use client";

import { useEffect, useState } from "react";
import { CreditCard, Phone, Mail, Calendar, Briefcase, MapPin, Users, RefreshCw, Shield, Plus, ArrowLeft } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";
import { formatEnumLabel, AccountTier } from "@/types/hrm.types";
import SectionGrantManager from "./SectionGrantManager";
import PermissionChip from "./PermissionChip";
import MailProvisioningCard from "./MailProvisioningCard";
import { useRouter } from "next/navigation";

const TIER_PERMISSIONS: Record<AccountTier, { heading: string; items: string[] }[]> = {
  SUPER: [
    {
      heading: "System-wide access",
      items: [
        "Full access to all modules (HRM, Finance, Operations, Marketing, etc.)",
        "Can view all data across departments",
      ],
    },
    {
      heading: "User & Access Control",
      items: [
        "Create, edit, delete ANY account (including admin)",
        "Assign or override roles, tiers, and permissions",
        "Approve or revoke access across system",
      ],
    },
  ],
  EMPLOYEE: [
    {
      heading: "Personal access only",
      items: ["View own profile", "Update personal password after onboarding", "View assigned tasks / duties"],
    },
  ],
  ADMIN: [
    {
      heading: "HRM Core Control",
      items: ["Create employee accounts", "Edit employee details", "Assign roles and permissions (within allowed boundaries)"],
    },
    {
      heading: "Account management",
      items: ["Activate / deactivate employee accounts", "Resend invites", "Reset employee credentials"],
    },
  ],
  EXECUTIVE: [
    {
      heading: "Read-heavy access",
      items: ["View all major dashboards (HRM, Finance, Operations, Marketing)", "Access high-level analytics and reports"],
    },
  ],
};

function InfoSection({ title, rows }: { title: string; rows: { label: string; value: string }[] }) {
  return (
    <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
      <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
      <div className="flex flex-col gap-2">
        {rows.map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="font-poppins text-[11px] font-semibold text-foreground">{label}</span>
            <span className="font-poppins text-[12px] text-muted-foreground">{value || "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return "—";
  }
}

// ✅ FIXED: Status badge with proper width (w-fit + inline-flex)
function StatusBadge({ status }: { status: string }) {
  const getStatusStyles = () => {
    switch (status) {
      case "ACTIVE":
        return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
      case "PENDING":
        return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
      case "INACTIVE":
        return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
      case "LOCKED":
        return "bg-gray-100 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400";
      default:
        return "bg-gray-100 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400";
    }
  };

  return (
    <span className={`inline-flex w-fit px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-medium ${getStatusStyles()}`}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

export default function ViewAccount({
  accountId,
  onBack,
  onEdit,
}: {
  accountId: string;
  onBack: () => void;
  onEdit: () => void;
}) {
  const router = useRouter();
  const {
    selectedAccount,
    isLoadingAccount,
    accountsError,
    fetchAccount,
    clearSelectedAccount,
    updateAccountStatus,
    resendAccountInvite,
    sectionGrants,
    isLoadingGrants,
    grantsError,
    fetchUserGrants,
    clearGrants,
  } = useHrmStore();

  const [actionLoading, setActionLoading] = useState<"activate" | "deactivate" | "invite" | null>(null);
  const [showGrantManager, setShowGrantManager] = useState(false);

  useEffect(() => {
    fetchAccount(accountId);
    fetchUserGrants(accountId);
    return () => {
      clearSelectedAccount();
      clearGrants();
    };
  }, [accountId, fetchAccount, fetchUserGrants, clearSelectedAccount, clearGrants]);

  const handleStatus = async (status: "ACTIVE" | "INACTIVE") => {
    setActionLoading(status === "ACTIVE" ? "activate" : "deactivate");
    try {
      await updateAccountStatus(accountId, status);
    } finally {
      setActionLoading(null);
    }
  };

  const handleInvite = async () => {
    setActionLoading("invite");
    try {
      await resendAccountInvite(accountId);
      // ✅ Redirect to change password page with forced flag
      router.push("/auth/change-password?forced=true");
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoadingAccount && !selectedAccount) {
    return (
      <div className="flex flex-col gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">Go Back</span>
        </button>
        <div className="flex flex-col md:flex-row gap-4">
          <div className="w-full md:w-[200px] h-[400px] bg-muted rounded-xl animate-pulse" />
          <div className="flex-1 h-[400px] bg-muted rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (accountsError || !selectedAccount) {
    return (
      <div className="flex flex-col gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">Go Back</span>
        </button>
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <p className="font-poppins text-[13px] text-red-500">{accountsError ?? "Account not found"}</p>
          <button
            onClick={() => fetchAccount(accountId)}
            className="flex items-center gap-1.5 text-[12px] font-poppins text-primary hover:underline"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      </div>
    );
  }

  const acc = selectedAccount;
  const perms = TIER_PERMISSIONS[acc.tier] ?? [];

  const isActive = acc.status === "ACTIVE";
  const isInactive = acc.status === "INACTIVE";
  const isPending = acc.status === "PENDING";
  const isLocked = acc.status === "LOCKED";
  const isNonActive = isPending || isInactive || isLocked;

  return (
    <>
      <div className="flex flex-col gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="font-poppins text-[12px] font-medium">Go Back</span>
        </button>

        <div className="flex flex-col md:flex-row gap-4 items-start">
          <div className="flex flex-col gap-3 w-full md:w-[200px] md:shrink-0">
            <div className="w-full md:w-[200px] h-[180px] rounded-xl overflow-hidden bg-muted flex items-center justify-center">
              <div className="w-full h-full bg-primary/10 flex items-center justify-center">
                <span className="text-[40px] font-poppins font-bold text-primary">{acc.name.charAt(0)}</span>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2.5">
              {[
                { icon: <CreditCard className="w-3.5 h-3.5" />, label: "Employee ID:", value: acc.employeeCode ?? "—" },
                { icon: <Phone className="w-3.5 h-3.5" />, label: "Phone Number:", value: acc.phone ?? "—" },
                { icon: <Mail className="w-3.5 h-3.5" />, label: "Email Address:", value: acc.email },
                { icon: <Calendar className="w-3.5 h-3.5" />, label: "Employment Date:", value: formatDate(acc.employmentDate) },
                { icon: <Briefcase className="w-3.5 h-3.5" />, label: "Position:", value: acc.position ?? "—" },
                { icon: <MapPin className="w-3.5 h-3.5" />, label: "Location:", value: acc.location ?? "—" },
                { icon: <Users className="w-3.5 h-3.5" />, label: "Head of Department:", value: acc.headOfDepartment ?? "—" },
              ].map(({ icon, label, value }) => (
                <div key={label} className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0 mt-0.5">{icon}</span>
                  <div className="flex flex-col min-w-0">
                    <span className="font-poppins text-[10px] text-muted-foreground">{label}</span>
                    <span className="font-poppins text-[11px] font-semibold text-foreground break-words">{value}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2">
              <h3 className="font-poppins text-[12px] font-semibold text-foreground">Quick Actions</h3>

              {/* ✅ Only show Send Invite for non-ACTIVE users */}
              {isNonActive && (
                <div className="flex flex-col gap-1.5">
                  <span className="font-poppins text-[11px] text-muted-foreground">Send Invite</span>
                  <button
                    onClick={handleInvite}
                    disabled={actionLoading === "invite"}
                    className="h-[34px] bg-primary text-white font-poppins text-[12px] font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
                  >
                    {actionLoading === "invite" ? "Sending..." : "Invite User"}
                  </button>
                </div>
              )}

              {/* For ACTIVE users, show a "Reset Password" button instead */}
              {isActive && (
                <div className="flex flex-col gap-1.5">
                  <span className="font-poppins text-[11px] text-muted-foreground">Reset Password</span>
                  <button
                    onClick={handleInvite}
                    disabled={actionLoading === "invite"}
                    className="h-[34px] bg-amber-500 text-white font-poppins text-[12px] font-semibold rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-60"
                  >
                    {actionLoading === "invite" ? "Sending..." : "Reset Password"}
                  </button>
                </div>
              )}

              {isActive && (
                <button
                  onClick={() => handleStatus("INACTIVE")}
                  disabled={actionLoading === "deactivate"}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted/50 transition-colors w-full text-left disabled:opacity-50"
                >
                  <span className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                    <span className="font-poppins text-[10px] font-bold text-white">D</span>
                  </span>
                  <span className="font-poppins text-[12px] text-foreground">
                    {actionLoading === "deactivate" ? "Disabling..." : "Disable Account"}
                  </span>
                </button>
              )}

              {isInactive && (
                <button
                  onClick={() => handleStatus("ACTIVE")}
                  disabled={actionLoading === "activate"}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted/50 transition-colors w-full text-left disabled:opacity-50"
                >
                  <span className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shrink-0">
                    <span className="font-poppins text-[10px] font-bold text-white">A</span>
                  </span>
                  <span className="font-poppins text-[12px] text-foreground">
                    {actionLoading === "activate" ? "Activating..." : "Activate Account"}
                  </span>
                </button>
              )}

              {(isPending || isLocked) && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 w-full">
                  <span className="w-6 h-6 rounded-full bg-amber-500 flex items-center justify-center shrink-0">
                    <span className="font-poppins text-[10px] font-bold text-white">!</span>
                  </span>
                  <span className="font-poppins text-[12px] text-muted-foreground capitalize">
                    Status: {acc.status.toLowerCase()}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 min-w-0 w-full flex flex-col gap-4">
            <InfoSection
              title="Personal Information"
              rows={[
                { label: "Employee Full Name", value: acc.name },
                { label: "Email Address", value: acc.email },
                { label: "Employee ID", value: acc.employeeCode ?? "—" },
              ]}
            />

            <InfoSection
              title="Job Information"
              rows={[
                { label: "Job Title", value: acc.jobTitle ?? acc.position ?? "—" },
                { label: "Department", value: formatEnumLabel(acc.department) },
                { label: "Designation / Role / Position", value: acc.designation ?? "—" },
              ]}
            />

            <InfoSection
              title="Employment Information"
              rows={[{ label: "Employment Type", value: acc.employmentType ?? "—" }]}
            />

            <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
              <h3 className="font-poppins text-[13px] font-semibold text-foreground">Account Classification</h3>
              
              <div className="flex flex-col gap-1">
                <span className="font-poppins text-[11px] font-semibold text-foreground">Account Tier</span>
                <span className="font-poppins text-[12px] text-muted-foreground">{formatEnumLabel(acc.tier)}</span>
              </div>
              
              {/* ✅ FIXED: Status badge with proper width - wrapped in flex container */}
              <div className="flex flex-col gap-1">
                <span className="font-poppins text-[11px] font-semibold text-foreground">Status</span>
                <div className="flex items-center">
                  <StatusBadge status={acc.status} />
                </div>
              </div>

              <div className="flex flex-col gap-2 mt-2 border-t border-border pt-3">
                <div className="flex items-center justify-between">
                  <span className="font-poppins text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5" />
                    Module Permissions
                  </span>
                  <button
                    onClick={() => setShowGrantManager(true)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-[11px] font-poppins font-medium hover:bg-primary/20 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    Manage
                  </button>
                </div>

                {isLoadingGrants ? (
                  <div className="flex items-center justify-center py-4">
                    <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" />
                  </div>
                ) : grantsError ? (
                  <p className="font-poppins text-[11px] text-red-500">{grantsError}</p>
                ) : !Array.isArray(sectionGrants) || sectionGrants.length === 0 ? (
                  <p className="font-poppins text-[11px] text-muted-foreground">No module permissions assigned.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {sectionGrants.map((grant) => (
                      <PermissionChip
                        key={grant.id}
                        module={grant.module}
                        section={grant.section}
                        mode={grant.mode}
                        size="sm"
                      />
                    ))}
                  </div>
                )}
              </div>

              {perms.length > 0 && (
                <div className="flex flex-col gap-1 mt-2 border-t border-border pt-3">
                  <span className="font-poppins text-[11px] font-semibold text-foreground">Tier Permissions</span>
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex flex-col gap-3 mt-1">
                    {perms.map((group) => (
                      <div key={group.heading}>
                        <p className="font-poppins text-[11px] font-semibold text-primary mb-1">{group.heading}</p>
                        <ul className="flex flex-col gap-0.5">
                          {group.items.map((item, i) => (
                            <li key={i} className="font-poppins text-[11px] text-primary/80 flex items-start gap-1.5">
                              <span className="shrink-0 mt-0.5">·</span>
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <MailProvisioningCard accountId={accountId} accountName={acc.name} />

        {/* Bottom action buttons */}
        <div className="grid grid-cols-2 gap-4 mt-2">
          {isActive && (
            <button
              onClick={() => handleStatus("INACTIVE")}
              disabled={actionLoading === "deactivate"}
              className="h-[50px] rounded-xl bg-red-500 text-white text-[14px] font-poppins font-semibold hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {actionLoading === "deactivate" ? "Disabling..." : "Disable Account"}
            </button>
          )}
          {isInactive && (
            <button
              onClick={() => handleStatus("ACTIVE")}
              disabled={actionLoading === "activate"}
              className="h-[50px] rounded-xl bg-emerald-500 text-white text-[14px] font-poppins font-semibold hover:bg-emerald-600 transition-colors disabled:opacity-50"
            >
              {actionLoading === "activate" ? "Activating..." : "Activate Account"}
            </button>
          )}
          {(isPending || isLocked) && (
            <div className="h-[50px] rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-[14px] font-poppins font-semibold flex items-center justify-center border border-amber-200 dark:border-amber-800 capitalize">
              Status: {acc.status.toLowerCase()}
            </div>
          )}
          <button
            onClick={onEdit}
            className="h-[50px] rounded-xl bg-primary text-white text-[14px] font-poppins font-semibold hover:bg-primary/90 transition-colors"
          >
            Edit
          </button>
        </div>
      </div>

      {showGrantManager && (
        <SectionGrantManager
          userId={accountId}
          userName={acc.name}
          onClose={() => {
            setShowGrantManager(false);
            fetchUserGrants(accountId);
          }}
        />
      )}
    </>
  );
}