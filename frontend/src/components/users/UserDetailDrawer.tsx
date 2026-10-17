"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import {
  X, ChevronLeft, ChevronRight,
  Activity, CreditCard, CalendarDays, BadgeCheck,
  Trash2, KeyRound, ShieldAlert, User,
  Stethoscope, Pill, FlaskConical,
  ChevronDown, AlertTriangle,
} from "lucide-react";
import { useUsersStore } from "@/stores/users.store";

// ── Shared style maps ─────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  active:                       { bg: "rgba(13,165,63,0.12)",   text: "#0DA53F", label: "Active" },
  doctor_active:                { bg: "rgba(13,165,63,0.12)",   text: "#0DA53F", label: "Doctor Active" },
  pharmacy_active:              { bg: "rgba(13,165,63,0.12)",   text: "#0DA53F", label: "Pharmacy Active" },
  locked:                       { bg: "rgba(246,69,69,0.12)",   text: "#F64545", label: "Locked" },
  pending_email_verification:   { bg: "rgba(245,158,11,0.12)",  text: "#F59E0B", label: "Pending Email" },
  pending_doctor_verification:  { bg: "rgba(245,158,11,0.12)",  text: "#F59E0B", label: "Pending Doctor" },
  pending_pharmacy_verification:{ bg: "rgba(245,158,11,0.12)",  text: "#F59E0B", label: "Pending Pharmacy" },
};

const ROLE_STYLES: Record<string, { bg: string; text: string }> = {
  doctor:    { bg: "rgba(39,46,167,0.10)",   text: "#272EA7" },
  patient:   { bg: "rgba(13,165,63,0.12)",   text: "#0DA53F" },
  pharmacy:  { bg: "rgba(232,182,0,0.12)",   text: "#E8B600" },
  lab_admin: { bg: "rgba(143,144,164,0.15)", text: "#8F90A4" },
  admin:     { bg: "rgba(246,69,69,0.12)",   text: "#F64545" },
};

const VALID_STATUSES = [
  { value: "active",                        label: "Active" },
  { value: "doctor_active",                 label: "Doctor Active" },
  { value: "pharmacy_active",               label: "Pharmacy Active" },
  { value: "locked",                        label: "Locked" },
  { value: "pending_email_verification",    label: "Pending Email Verification" },
  { value: "pending_doctor_verification",   label: "Pending Doctor Verification" },
  { value: "pending_pharmacy_verification", label: "Pending Pharmacy Verification" },
];

// ── Small helpers ─────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-2.5 border-b border-border/50 gap-3">
      <span className="text-[12px] font-poppins text-muted-foreground shrink-0">{label}</span>
      <span className="text-[12px] font-poppins font-medium text-foreground text-right break-all">{value ?? "—"}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-poppins font-semibold text-muted-foreground uppercase tracking-widest mt-4 mb-1">
      {children}
    </p>
  );
}

function ActivityStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col items-center gap-1 flex-1 py-4 bg-muted/50 rounded-2xl">
      <span className="text-[22px] font-poppins font-bold" style={{ color }}>{value}</span>
      <span className="text-[11px] font-poppins text-muted-foreground text-center">{label}</span>
    </div>
  );
}

function PaginationRow({
  page, totalPages, onPage,
}: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-1 pt-2">
      <button onClick={() => onPage(page - 1)} disabled={page === 1}
        className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30 transition-colors">
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <span className="text-[11px] font-poppins text-muted-foreground">{page} / {totalPages}</span>
      <button onClick={() => onPage(page + 1)} disabled={page === totalPages}
        className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30 transition-colors">
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────────────

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmClass,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClass: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative bg-card border border-border rounded-2xl p-6 w-full max-w-[340px] shadow-2xl flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-destructive/10 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-destructive" />
          </div>
          <div>
            <p className="text-[14px] font-poppins font-semibold text-foreground">{title}</p>
            <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">{message}</p>
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onCancel}
            className="flex-1 h-[38px] rounded-xl border border-border text-[13px] font-poppins font-medium text-foreground hover:bg-muted transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm}
            className={`flex-1 h-[38px] rounded-xl text-[13px] font-poppins font-semibold text-white transition-colors ${confirmClass}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tab: Overview ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const user = useUsersStore((s) => s.selectedUser)!;

  const doctor   = user.doctor_profiles;
  const patient  = user.patient_profiles;
  const pharmacy = user.pharmacy_profiles;
  const license  = doctor?.professional_licenses?.[0];

  return (
    <div className="flex flex-col">
      <SectionTitle>Account</SectionTitle>
      <InfoRow label="User ID"    value={<span className="text-[10px] font-mono">{user.id}</span>} />
      <InfoRow label="Phone"      value={user.phoneNumber} />
      <InfoRow label="Tier"       value={<span className="capitalize">{user.tier}</span>} />
      <InfoRow label="Last Login" value={user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never"} />
      <InfoRow label="Joined"     value={new Date(user.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} />
      <InfoRow label="Updated"    value={new Date(user.updatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} />

      {/* Doctor profile */}
      {doctor && (
        <>
          <SectionTitle>Doctor Profile</SectionTitle>
          <InfoRow label="Gender"         value={doctor.gender} />
          <InfoRow label="Date of Birth"  value={doctor.dateOfBirth ? new Date(doctor.dateOfBirth).toLocaleDateString("en-GB") : null} />
          <InfoRow label="Nationality"    value={doctor.nationality} />
          <InfoRow label="Contact"        value={doctor.contactNumber} />
          {license && (
            <>
              <SectionTitle>License</SectionTitle>
              <InfoRow label="License No."    value={license.medicalLicenseNumber} />
              <InfoRow label="Country"        value={license.countryOfLicense} />
              <InfoRow label="Authority"      value={license.licenseAuthority} />
              <InfoRow label="Expiry"         value={license.licenseExpiryDate ? new Date(license.licenseExpiryDate).toLocaleDateString("en-GB") : null} />
              <InfoRow label="Experience"     value={license.yearsOfExperience ? `${license.yearsOfExperience} yrs` : null} />
              {license.areasOfSpecialization?.length ? (
                <InfoRow label="Specialization" value={license.areasOfSpecialization.join(", ")} />
              ) : null}
            </>
          )}
        </>
      )}

      {/* Patient profile */}
      {patient && (
        <>
          <SectionTitle>Patient Profile</SectionTitle>
          <InfoRow label="Gender"        value={patient.gender} />
          <InfoRow label="Date of Birth" value={patient.dateOfBirth ? new Date(patient.dateOfBirth).toLocaleDateString("en-GB") : null} />
          <InfoRow label="Blood Group"   value={patient.bloodGroup} />
          <InfoRow label="Genotype"      value={patient.genotype} />
          <InfoRow label="Nationality"   value={patient.nationality} />
        </>
      )}

      {/* Pharmacy profile */}
      {pharmacy && (
        <>
          <SectionTitle>Pharmacy Profile</SectionTitle>
          <InfoRow label="Name"          value={pharmacy.pharmacyName} />
          <InfoRow label="Reg. Number"   value={pharmacy.registrationNumber} />
          <InfoRow label="Address"       value={pharmacy.address} />
          <InfoRow label="Phone"         value={pharmacy.phone} />
          <InfoRow label="Verification"  value={pharmacy.verificationStatus} />
          <InfoRow label="Active"        value={pharmacy.isActive ? "Yes" : "No"} />
        </>
      )}
    </div>
  );
}

// ── Tab: Activity ─────────────────────────────────────────────────────────────

function ActivityTab() {
  const user       = useUsersStore((s) => s.selectedUser)!;
  const activity   = useUsersStore((s) => s.userActivity);
  const isLoading  = useUsersStore((s) => s.isLoadingActivity);
  const fetchAct   = useUsersStore((s) => s.fetchUserActivity);

  useEffect(() => { fetchAct(user.id); }, [user.id]);

  if (isLoading || !activity) {
    return (
      <div className="grid grid-cols-2 gap-2 pt-2 animate-pulse">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-muted rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="grid grid-cols-2 gap-2">
        <ActivityStat label="Appointments"  value={activity.appointments}  color="#272EA7" />
        <ActivityStat label="Transactions"  value={activity.transactions}  color="#0DA53F" />
        <ActivityStat label="Prescriptions" value={activity.prescriptions} color="#E8B600" />
        <ActivityStat label="Lab Orders"    value={activity.labOrders}     color="#8F90A4" />
      </div>
    </div>
  );
}

// ── Tab: Transactions ─────────────────────────────────────────────────────────

function TransactionsTab() {
  const user       = useUsersStore((s) => s.selectedUser)!;
  const txns       = useUsersStore((s) => s.userTransactions);
  const pagination = useUsersStore((s) => s.userTransactionsPagination);
  const isLoading  = useUsersStore((s) => s.isLoadingTransactions);
  const fetchTxns  = useUsersStore((s) => s.fetchUserTransactions);

  useEffect(() => { fetchTxns(user.id, 1); }, [user.id]);

  const STATUS_COLOR: Record<string, string> = {
    completed: "#0DA53F",
    pending:   "#F59E0B",
    failed:    "#F64545",
    refunded:  "#8F90A4",
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 pt-2 animate-pulse">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 bg-muted rounded-xl" />
        ))}
      </div>
    );
  }

  if (!txns.length) {
    return <p className="text-[13px] font-poppins text-muted-foreground text-center py-10">No transactions found</p>;
  }

  return (
    <div className="flex flex-col gap-1 pt-2">
      {txns.map((t) => (
        <div key={t.id} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-muted/40 hover:bg-muted/70 transition-colors">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[12px] font-poppins font-medium text-foreground capitalize truncate">{t.serviceType}</span>
            <span className="text-[11px] font-poppins text-muted-foreground">
              {new Date(t.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5 shrink-0 ml-2">
            <span className="text-[13px] font-poppins font-bold text-foreground">
              {t.originalCurrency} {t.originalAmount.toLocaleString()}
            </span>
            <span className="text-[10px] font-poppins font-semibold capitalize" style={{ color: STATUS_COLOR[t.status] ?? "#8F90A4" }}>
              {t.status}
            </span>
          </div>
        </div>
      ))}
      <PaginationRow
        page={pagination?.currentPage ?? 1}
        totalPages={pagination?.totalPages ?? 1}
        onPage={(p) => fetchTxns(user.id, p)}
      />
    </div>
  );
}

// ── Tab: Appointments ─────────────────────────────────────────────────────────

function AppointmentsTab() {
  const user       = useUsersStore((s) => s.selectedUser)!;
  const appts      = useUsersStore((s) => s.userAppointments);
  const pagination = useUsersStore((s) => s.userAppointmentsPagination);
  const isLoading  = useUsersStore((s) => s.isLoadingAppointments);
  const fetchAppts = useUsersStore((s) => s.fetchUserAppointments);

  useEffect(() => { fetchAppts(user.id, 1); }, [user.id]);

  const APPT_COLOR: Record<string, string> = {
    completed: "#0DA53F",
    scheduled: "#272EA7",
    cancelled: "#F64545",
    pending:   "#F59E0B",
    ongoing:   "#E8B600",
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 pt-2 animate-pulse">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 bg-muted rounded-xl" />
        ))}
      </div>
    );
  }

  if (!appts.length) {
    return <p className="text-[13px] font-poppins text-muted-foreground text-center py-10">No appointments found</p>;
  }

  return (
    <div className="flex flex-col gap-1 pt-2">
      {appts.map((a) => (
        <div key={a.id} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-muted/40 hover:bg-muted/70 transition-colors">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[12px] font-poppins font-medium text-foreground capitalize truncate">{a.type} appointment</span>
            <span className="text-[11px] font-poppins text-muted-foreground">
              {new Date(a.appointmentDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
              {a.appointmentTime ? ` · ${a.appointmentTime}` : ""}
            </span>
            {a.reason && (
              <span className="text-[11px] font-poppins text-muted-foreground/70 truncate max-w-[180px]">{a.reason}</span>
            )}
          </div>
          <div className="flex flex-col items-end gap-0.5 shrink-0 ml-2">
            <span className="text-[10px] font-poppins font-semibold capitalize" style={{ color: APPT_COLOR[a.status] ?? "#8F90A4" }}>
              {a.status}
            </span>
            <span className="text-[11px] font-poppins text-muted-foreground">
              {a.paymentStatus}
            </span>
          </div>
        </div>
      ))}
      <PaginationRow
        page={pagination?.currentPage ?? 1}
        totalPages={pagination?.totalPages ?? 1}
        onPage={(p) => fetchAppts(user.id, p)}
      />
    </div>
  );
}

// ── Tab: Subscriptions ────────────────────────────────────────────────────────

function SubscriptionsTab() {
  const user    = useUsersStore((s) => s.selectedUser)!;
  const subs    = useUsersStore((s) => s.userSubscriptions);
  const loading = useUsersStore((s) => s.isLoadingSubscriptions);
  const fetchS  = useUsersStore((s) => s.fetchUserSubscriptions);

  useEffect(() => { fetchS(user.id); }, [user.id]);

  const SUB_COLOR: Record<string, string> = {
    active:    "#0DA53F",
    expired:   "#F64545",
    cancelled: "#8F90A4",
    pending:   "#F59E0B",
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-2 pt-2 animate-pulse">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 bg-muted rounded-xl" />
        ))}
      </div>
    );
  }

  if (!subs.length) {
    return <p className="text-[13px] font-poppins text-muted-foreground text-center py-10">No subscriptions found</p>;
  }

  return (
    <div className="flex flex-col gap-2 pt-2">
      {subs.map((s) => (
        <div key={s.id} className="flex flex-col gap-2 px-3 py-3 rounded-xl bg-muted/40 border border-border/50">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-poppins font-semibold text-foreground capitalize">{s.tier} — {s.planType}</span>
            <span className="text-[10px] font-poppins font-bold capitalize px-2 py-0.5 rounded-full" style={{
              color: SUB_COLOR[s.status] ?? "#8F90A4",
              backgroundColor: `${SUB_COLOR[s.status] ?? "#8F90A4"}18`,
            }}>
              {s.status}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-poppins text-muted-foreground">{s.currency} {s.price?.toLocaleString()} / {s.billingCycle}</span>
            <span className="text-[11px] font-poppins text-muted-foreground">
              {new Date(s.startDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
              {" → "}
              {new Date(s.endDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
            </span>
          </div>
          {s.autoRenew !== undefined && (
            <span className="text-[11px] font-poppins text-muted-foreground">
              Auto-renew: {s.autoRenew ? "On" : "Off"}
              {s.canceledAt ? ` · Cancelled ${new Date(s.canceledAt).toLocaleDateString("en-GB")}` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main drawer ───────────────────────────────────────────────────────────────

type Tab = "overview" | "activity" | "transactions" | "appointments" | "subscriptions";

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "overview",      label: "Overview",      icon: User },
  { key: "activity",      label: "Activity",      icon: Activity },
  { key: "transactions",  label: "Transactions",  icon: CreditCard },
  { key: "appointments",  label: "Appointments",  icon: CalendarDays },
  { key: "subscriptions", label: "Subscriptions", icon: BadgeCheck },
];

export default function UserDetailDrawer() {
  const selectedUser     = useUsersStore((s) => s.selectedUser);
  const isLoadingUser    = useUsersStore((s) => s.isLoadingUser);
  const clearSelectedUser = useUsersStore((s) => s.clearSelectedUser);
  const updateStatus     = useUsersStore((s) => s.updateUserStatus);
  const doDelete         = useUsersStore((s) => s.deleteUser);
  const doForceReset     = useUsersStore((s) => s.forcePasswordReset);
  const isUpdating       = useUsersStore((s) => s.isUpdatingStatus);
  const isDeleting       = useUsersStore((s) => s.isDeleting);

  const [activeTab, setActiveTab]         = useState<Tab>("overview");
  const [statusOpen, setStatusOpen]       = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset]   = useState(false);
  const [resetDone, setResetDone]         = useState(false);

  // Reset tab when new user opens
  useEffect(() => {
    if (selectedUser) { setActiveTab("overview"); setResetDone(false); }
  }, [selectedUser?.id]);

  if (!selectedUser && !isLoadingUser) return null;

  const handleStatusChange = async (status: string) => {
    if (!selectedUser) return;
    setStatusOpen(false);
    await updateStatus(selectedUser.id, status);
  };

  const handleDelete = async () => {
    if (!selectedUser) return;
    setConfirmDelete(false);
    await doDelete(selectedUser.id);
    clearSelectedUser();
  };

  const handleForceReset = async () => {
    if (!selectedUser) return;
    setConfirmReset(false);
    await doForceReset(selectedUser.id);
    setResetDone(true);
  };

  const ss = selectedUser ? (STATUS_STYLES[selectedUser.status] ?? { bg: "rgba(143,144,164,0.15)", text: "#8F90A4", label: selectedUser.status }) : null;
  const rs = selectedUser ? (ROLE_STYLES[selectedUser.role] ?? { bg: "rgba(143,144,164,0.15)", text: "#8F90A4" }) : null;

  return (
    <>
      {/* Confirm dialogs */}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete User"
          message={`This will permanently delete ${selectedUser?.fullName}. This cannot be undone.`}
          confirmLabel="Delete"
          confirmClass="bg-destructive hover:bg-destructive/90"
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {confirmReset && (
        <ConfirmDialog
          title="Force Password Reset"
          message={`${selectedUser?.fullName} will be required to set a new password on next login.`}
          confirmLabel="Force Reset"
          confirmClass="bg-amber-500 hover:bg-amber-600"
          onConfirm={handleForceReset}
          onCancel={() => setConfirmReset(false)}
        />
      )}

      {/* Backdrop + drawer */}
      <div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={clearSelectedUser} />

        <div className="relative w-full max-w-[460px] h-full bg-card border-l border-border flex flex-col shadow-2xl animate-in slide-in-from-right-4 duration-300">

          {/* ── Drawer header ── */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <h3 className="text-[15px] font-poppins font-semibold text-foreground">User Details</h3>
            <button
              onClick={clearSelectedUser}
              className="w-8 h-8 flex items-center justify-center rounded-xl hover:bg-muted transition-colors"
            >
              <X className="w-4 h-4 text-foreground" />
            </button>
          </div>

          {isLoadingUser ? (
            /* ── Loading skeleton ── */
            <div className="flex-1 p-5 flex flex-col gap-4 animate-pulse">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-muted shrink-0" />
                <div className="flex flex-col gap-2 flex-1">
                  <div className="h-4 bg-muted rounded-full w-32" />
                  <div className="h-3 bg-muted rounded-full w-44" />
                  <div className="h-3 bg-muted rounded-full w-20" />
                </div>
              </div>
              <div className="flex gap-1">
                {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-8 bg-muted rounded-xl flex-1" />)}
              </div>
              {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-4 bg-muted rounded-full" />)}
            </div>
          ) : selectedUser ? (
            <div className="flex-1 flex flex-col overflow-hidden">

              {/* ── User hero ── */}
              <div className="px-5 py-4 border-b border-border shrink-0">
                <div className="flex items-center gap-4">
                  {/* Avatar */}
                  <div className="w-14 h-14 rounded-2xl bg-primary/10 overflow-hidden shrink-0 ring-2 ring-primary/10">
                    {selectedUser.profileImageUrl ? (
                      <Image src={selectedUser.profileImageUrl} alt={selectedUser.fullName} width={56} height={56} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="text-[22px] font-poppins font-bold text-primary">
                          {selectedUser.fullName.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Name + email + badges */}
                  <div className="flex flex-col gap-1 min-w-0">
                    <p className="text-[15px] font-poppins font-semibold text-foreground truncate">{selectedUser.fullName}</p>
                    <p className="text-[12px] font-poppins text-muted-foreground truncate">{selectedUser.email}</p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-poppins font-semibold capitalize"
                        style={{ backgroundColor: rs!.bg, color: rs!.text }}>
                        {selectedUser.role.replace("_", " ")}
                      </span>
                      <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-poppins font-semibold"
                        style={{ backgroundColor: ss!.bg, color: ss!.text }}>
                        {ss!.label}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Action buttons row */}
                <div className="flex items-center gap-2 mt-4">

                  {/* Status changer */}
                  <div className="relative flex-1">
                    <button
                      onClick={() => setStatusOpen((o) => !o)}
                      disabled={isUpdating}
                      className="w-full flex items-center justify-center gap-1.5 h-[34px] px-3 bg-muted border border-border rounded-xl text-[12px] font-poppins font-medium text-foreground hover:border-primary/50 transition-colors disabled:opacity-50"
                    >
                      <ShieldAlert className="w-3.5 h-3.5 text-muted-foreground" />
                      {isUpdating ? "Updating…" : "Set Status"}
                      <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    </button>
                    {statusOpen && (
                      <div className="absolute top-full left-0 mt-1 w-56 bg-card border border-border rounded-2xl shadow-xl z-20 overflow-hidden">
                        {VALID_STATUSES.map((s) => (
                          <button
                            key={s.value}
                            onClick={() => handleStatusChange(s.value)}
                            className={`w-full flex items-center justify-between px-3 py-2.5 text-[12px] font-poppins text-foreground hover:bg-muted transition-colors ${selectedUser.status === s.value ? "bg-primary/5 text-primary font-semibold" : ""}`}
                          >
                            {s.label}
                            {selectedUser.status === s.value && <div className="w-1.5 h-1.5 rounded-full bg-primary" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Force password reset */}
                  <button
                    onClick={() => !resetDone && setConfirmReset(true)}
                    className={`flex items-center justify-center gap-1.5 h-[34px] px-3 rounded-xl border text-[12px] font-poppins font-medium transition-colors ${
                      resetDone
                        ? "bg-amber-50 border-amber-200 text-amber-600 cursor-default"
                        : "bg-muted border-border text-foreground hover:border-amber-400 hover:text-amber-600"
                    }`}
                    title="Force Password Reset"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    {resetDone ? "Reset flagged" : "Reset pwd"}
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => setConfirmDelete(true)}
                    disabled={isDeleting}
                    className="flex items-center justify-center gap-1.5 h-[34px] px-3 bg-muted border border-border rounded-xl text-[12px] font-poppins font-medium text-foreground hover:border-destructive/50 hover:text-destructive transition-colors disabled:opacity-50"
                    title="Delete User"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* ── Tabs ── */}
              <div className="flex items-center gap-0.5 px-3 py-2 border-b border-border shrink-0 overflow-x-auto scrollbar-none">
                {TABS.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl whitespace-nowrap text-[12px] font-poppins font-medium transition-all duration-200 shrink-0 ${
                      activeTab === key
                        ? "bg-primary text-white"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              {/* ── Tab content ── */}
              <div className="flex-1 overflow-y-auto px-5 pb-8">
                {activeTab === "overview"      && <OverviewTab />}
                {activeTab === "activity"      && <ActivityTab />}
                {activeTab === "transactions"  && <TransactionsTab />}
                {activeTab === "appointments"  && <AppointmentsTab />}
                {activeTab === "subscriptions" && <SubscriptionsTab />}
              </div>

            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}