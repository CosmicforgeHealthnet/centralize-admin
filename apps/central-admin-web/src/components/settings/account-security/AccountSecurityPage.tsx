"use client";

import { useState } from "react";
import { useAuthStore } from "@/stores/auth.store";

/* ─── Change Password ─────────────────────────────────────── */
function ChangePasswordCard() {
  const { changePassword, isLoading, error, clearError } = useAuthStore();

  const [form, setForm] = useState({
    current: "",
    next: "",
    confirm: "",
  });
  const [success, setSuccess] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleChange = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [key]: e.target.value }));
    setLocalError(null);
    clearError();
    setSuccess(false);
  };

  const handleSubmit = async () => {
    setLocalError(null);
    setSuccess(false);

    if (!form.current || !form.next || !form.confirm) {
      setLocalError("All fields are required.");
      return;
    }
    if (form.next !== form.confirm) {
      setLocalError("New passwords do not match.");
      return;
    }

    try {
      await changePassword(form.current, form.next, form.confirm);
      setSuccess(true);
      setForm({ current: "", next: "", confirm: "" });
    } catch (_) {
      // error is set in store
    }
  };

  const displayError = localError || error;

  return (
    <div className="bg-card rounded-xl border border-border p-6 flex flex-col gap-5">
      <h2 className="text-[15px] font-poppins font-semibold text-foreground">
        Change Password
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-poppins text-foreground">
            Current Password
          </label>
          <input
            type="password"
            value={form.current}
            onChange={handleChange("current")}
            placeholder="Enter current password"
            className="h-[40px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-poppins text-foreground">
            New Password
          </label>
          <input
            type="password"
            value={form.next}
            onChange={handleChange("next")}
            placeholder="Enter new password"
            className="h-[40px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5 max-w-sm">
        <label className="text-[13px] font-poppins text-foreground">
          Confirm New Password
        </label>
        <input
          type="password"
          value={form.confirm}
          onChange={handleChange("confirm")}
          placeholder="Confirm new password"
          className="h-[40px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
        />
      </div>

      {/* Requirements */}
      <div className="rounded-lg bg-primary/5 border border-primary/15 px-4 py-3 flex flex-col gap-1">
        <p className="text-[12px] font-poppins font-semibold text-foreground mb-0.5">
          Password Requirement
        </p>
        {[
          "At least 8 characters long",
          "Contains at least one uppercase letter",
          "Contains at least one lowercase letter",
          "Contains at least one number or special character",
        ].map((req) => (
          <p key={req} className="text-[12px] font-poppins text-primary flex items-start gap-1.5">
            <span className="mt-[3px] shrink-0">•</span> {req}
          </p>
        ))}
      </div>

      {/* Error / Success feedback */}
      {displayError && (
        <p className="text-[12px] font-poppins text-red-500">{displayError}</p>
      )}
      {success && (
        <p className="text-[12px] font-poppins text-green-600">
          Password changed successfully. Please log in again.
        </p>
      )}

      <div>
        <button
          onClick={handleSubmit}
          disabled={isLoading}
          className="h-[40px] px-6 bg-primary text-white text-[13px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isLoading ? "Updating..." : "Update Password"}
        </button>
      </div>
    </div>
  );
}

/* ─── Reset Password ──────────────────────────────────────── */
function ResetPasswordCard() {
  const {
    requestPasswordReset,
    resetRequestLoading,
    resetRequestError,
    resetRequestSuccess,
    clearResetState,
  } = useAuthStore();

  const [form, setForm] = useState({
    fullName: "",
    email: "",
    position: "",
  });
  const [localError, setLocalError] = useState<string | null>(null);

  const handleChange = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [key]: e.target.value }));
    setLocalError(null);
    clearResetState();
  };

  const handleSubmit = async () => {
    setLocalError(null);

    if (!form.fullName.trim() || !form.email.trim() || !form.position.trim()) {
      setLocalError("All fields are required.");
      return;
    }

    try {
      await requestPasswordReset(form.fullName, form.email, form.position);
      setForm({ fullName: "", email: "", position: "" });
    } catch (_) {
      // error is set in store
    }
  };

  const displayError = localError || resetRequestError;

  return (
    <div className="bg-card rounded-xl border border-border p-6 flex flex-col gap-5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[15px] font-poppins font-semibold text-foreground">
          Reset Password
        </h2>
        <p className="text-[12px] font-poppins text-primary">
          Forgot Password? Fill in the fields below to authorize password reset.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-poppins text-foreground">Full Name</label>
          <input
            type="text"
            value={form.fullName}
            onChange={handleChange("fullName")}
            placeholder="Enter full name"
            className="h-[40px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-poppins text-foreground">Email</label>
          <input
            type="email"
            value={form.email}
            onChange={handleChange("email")}
            placeholder="Enter email address"
            className="h-[40px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5 max-w-sm">
        <label className="text-[13px] font-poppins text-foreground">Position</label>
        <input
          type="text"
          value={form.position}
          onChange={handleChange("position")}
          placeholder="Enter your position"
          className="h-[40px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
        />
      </div>

      {/* Note */}
      <div className="rounded-lg bg-primary/5 border border-primary/15 px-4 py-3 flex flex-col gap-1">
        <p className="text-[12px] font-poppins font-semibold text-foreground mb-0.5">
          Note
        </p>
        {[
          "You must fill all the required fields.",
          'Clicking the button "Request Authorization" will send a message to the HR Admin',
          "After Authorization is granted, you will receive a temporary password in your email.",
          "Change password to reset password.",
        ].map((note) => (
          <p key={note} className="text-[12px] font-poppins text-primary flex items-start gap-1.5">
            <span className="mt-[3px] shrink-0">•</span> {note}
          </p>
        ))}
      </div>

      {/* Error / Success feedback */}
      {displayError && (
        <p className="text-[12px] font-poppins text-red-500">{displayError}</p>
      )}
      {resetRequestSuccess && (
        <p className="text-[12px] font-poppins text-green-600">{resetRequestSuccess}</p>
      )}

      <div>
        <button
          onClick={handleSubmit}
          disabled={resetRequestLoading}
          className="h-[40px] px-6 bg-primary text-white text-[13px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {resetRequestLoading ? "Sending..." : "Request Authorization"}
        </button>
      </div>
    </div>
  );
}

/* ─── Delete Account ──────────────────────────────────────── */
function DeleteAccountCard() {
  return (
    <div className="bg-red-50 dark:bg-red-950/20 rounded-xl border border-red-200 dark:border-red-900/40 px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <p className="text-[13px] font-poppins font-semibold text-red-600 dark:text-red-400">
          Delete Account
        </p>
        <p className="text-[12px] font-poppins text-red-500/80 dark:text-red-400/70 max-w-md">
          When you delete your account, you loose complete access and your account gets deleted
          permanently. You can cancel deletion within 14 days.
        </p>
      </div>
      <button
        disabled
        className="shrink-0 h-[38px] px-5 bg-red-600 hover:bg-red-700 text-white text-[13px] font-poppins font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Delete Account
      </button>
    </div>
  );
}

/* ─── Main ────────────────────────────────────────────────── */
export default function AccountSecurityPage() {
  return (
    <div className="flex flex-col gap-5">
      <ChangePasswordCard />
      <ResetPasswordCard />
      <DeleteAccountCard />
    </div>
  );
}