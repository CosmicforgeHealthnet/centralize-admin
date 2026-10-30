"use client";

import Image from "next/image";
import { useState } from "react";
import { useAuthStore } from "@/stores/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ChangePasswordPage() {
  const { changePassword, isLoading, error, clearError, user, logout } = useAuthStore();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [currentPasswordError, setCurrentPasswordError] = useState("");
  const [newPasswordError, setNewPasswordError] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");
  const [success, setSuccess] = useState(false);

  const validateCurrentPassword = (val: string) => {
    if (!val) return "Current password is required";
    return "";
  };

  const validateNewPassword = (val: string) => {
    if (!val) return "New password is required";
    if (val.length < 8) return "Password must be at least 8 characters";
    if (!/[A-Z]/.test(val)) return "Password must contain an uppercase letter";
    if (!/[a-z]/.test(val)) return "Password must contain a lowercase letter";
    if (!/[0-9]/.test(val)) return "Password must contain a number";
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(val))
      return "Password must contain a special character";
    return "";
  };

  const validateConfirmPassword = (val: string, newVal: string) => {
    if (!val) return "Please confirm your new password";
    if (val !== newVal) return "Passwords do not match";
    return "";
  };

  const handleSubmit = async () => {
    const cErr = validateCurrentPassword(currentPassword);
    const nErr = validateNewPassword(newPassword);
    const pErr = validateConfirmPassword(confirmPassword, newPassword);
    setCurrentPasswordError(cErr);
    setNewPasswordError(nErr);
    setConfirmPasswordError(pErr);
    if (cErr || nErr || pErr) return;

    clearError();
    try {
      await changePassword(currentPassword, newPassword, confirmPassword);
      setSuccess(true);

      setTimeout(() => {
        // The backend revokes ALL refresh tokens on every password change
        // (see authService.changePassword — refreshToken.updateMany isRevoked: true),
        // not just forced resets. So the current session is dead either way.
        // Always log out fully and send the user back to login — never dashboard,
        // since a client-side push to /dashboard would just load, then get kicked
        // back out the moment an API call 401s and the token refresh fails.
        logout().then(() => {
          window.location.href = "/";
        });
      }, 1500);
    } catch {
      // error is already set in the store
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center px-4 py-10 sm:px-8">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex justify-center">
          <Image
            src="/logo.svg"
            alt="Cosmicforge Healthnet Logo"
            width={200}
            height={57}
            className="object-contain max-w-[160px] sm:max-w-[200px]"
          />
        </div>

        <div className="space-y-1 mb-6 text-center">
          <h1 className="text-title text-black">Change Your Password</h1>
          <p className="text-body-text text-muted-foreground py-2">
            {user?.name ? `Welcome, ${user.name}. ` : ""}
            You must set a new password before continuing. After changing, you
            will be redirected to login.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-4 rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
            Password changed successfully. Redirecting to login…
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="currentPassword" className="text-priority">
              Current Password
            </Label>
            <Input
              id="currentPassword"
              type="password"
              placeholder="Enter your current password"
              className="h-[50px] bg-white border-[#0000001C]"
              value={currentPassword}
              onChange={(e) => {
                setCurrentPassword(e.target.value);
                if (currentPasswordError) setCurrentPasswordError("");
              }}
              onBlur={() =>
                setCurrentPasswordError(validateCurrentPassword(currentPassword))
              }
              disabled={isLoading || success}
              aria-invalid={!!currentPasswordError}
            />
            {currentPasswordError && (
              <p className="text-xs text-destructive mt-1">{currentPasswordError}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="newPassword" className="text-priority">
              New Password
            </Label>
            <Input
              id="newPassword"
              type="password"
              placeholder="Enter a new password"
              className="h-[50px] bg-white border-[#0000001C]"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                if (newPasswordError) setNewPasswordError("");
                if (confirmPassword && confirmPasswordError) {
                  setConfirmPasswordError(
                    validateConfirmPassword(confirmPassword, e.target.value),
                  );
                }
              }}
              onBlur={() => setNewPasswordError(validateNewPassword(newPassword))}
              disabled={isLoading || success}
              aria-invalid={!!newPasswordError}
            />
            {newPasswordError ? (
              <p className="text-xs text-destructive mt-1">{newPasswordError}</p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">
                8+ characters, with uppercase, lowercase, a number, and a special character.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword" className="text-priority">
              Confirm New Password
            </Label>
            <Input
              id="confirmPassword"
              type="password"
              placeholder="Re-enter your new password"
              className="h-[50px] bg-white border-[#0000001C]"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (confirmPasswordError) setConfirmPasswordError("");
              }}
              onBlur={() =>
                setConfirmPasswordError(
                  validateConfirmPassword(confirmPassword, newPassword),
                )
              }
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              disabled={isLoading || success}
              aria-invalid={!!confirmPasswordError}
            />
            {confirmPasswordError && (
              <p className="text-xs text-destructive mt-1">{confirmPasswordError}</p>
            )}
          </div>

          <Button
            className="w-full text-subheading text-white mt-2"
            onClick={handleSubmit}
            disabled={
              isLoading || success || !currentPassword || !newPassword || !confirmPassword
            }
          >
            {isLoading ? "Updating…" : "Change Password"}
          </Button>
        </div>
      </div>
    </div>
  );
}