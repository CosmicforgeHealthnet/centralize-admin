"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { classifyMailError, stepUp } from "@/lib/mail.service";
import { emBtn, emBtnOutline, emInput } from "./em-ui";

/** User-facing text for shared-MFA step-up failures (codes from the Mail API). */
export function stepUpErrorMessage(code: string | undefined, fallback: string): string {
  switch (code) {
    case "MAIL_MFA_NOT_ENROLLED":
      return "Two-factor authentication is not set up for your account, so this action is not available yet.";
    case "MAIL_MFA_SESSION_REQUIRED":
      return "Your sign-in session can't confirm this action. Sign out and sign in again, then retry.";
    case "MAIL_MFA_LOCKED":
      return "Too many incorrect codes. Two-factor verification is locked for 15 minutes.";
    case "MAIL_MFA_UNAVAILABLE":
      return "Two-factor verification is not available on this server yet.";
    case "MAIL_MFA_INVALID":
      return "That code is not valid or was already used. Wait for the next code and try again.";
    default:
      return fallback;
  }
}

/** Collects a fresh TOTP code and exchanges it for a short-lived step-up id. */
export default function StepUpDialog({
  purpose,
  title,
  onVerified,
  onCancel,
}: {
  purpose: string;
  title: string;
  onVerified: (stepUpId: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsEnrollment, setNeedsEnrollment] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevFocus = useRef<Element | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (prevFocus.current instanceof HTMLElement) prevFocus.current.focus();
    };
  }, [onCancel]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await stepUp(code.trim(), purpose);
      await onVerified(res.stepUpId);
    } catch (err) {
      const info = classifyMailError(err);
      setNeedsEnrollment(info.code === "MAIL_MFA_NOT_ENROLLED");
      setError(stepUpErrorMessage(info.code, info.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="stepup-title"
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
      >
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 id="stepup-title" className="text-[14px] font-semibold">{title}</h2>
        </div>
        <p className="mb-3 text-[12px] text-muted-foreground">Enter the current 6-digit code from your authenticator app.</p>
        <label htmlFor="stepup-code" className="sr-only">Authentication code</label>
        <input
          id="stepup-code"
          ref={inputRef}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className={emInput}
        />
        {error && <p role="alert" className="mt-2 text-[11px] text-red-600">{error}</p>}
        {needsEnrollment && (
          <Link href="/dashboard/settings?tab=account-security" className="mt-1 inline-block text-[11px] font-semibold text-primary underline">
            Set up two-factor authentication
          </Link>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={emBtnOutline}>Cancel</button>
          <button type="submit" disabled={code.length !== 6 || busy} className={emBtn}>{busy ? "Verifying…" : "Verify"}</button>
        </div>
      </form>
    </div>
  );
}
