"use client";

// Session MFA step-up for product pages. Mount <MfaStepUpProvider> once around
// a product section; any child can then call useMfaStepUp().withStepUp(fn)
// (or use the product query/mutation hooks, which do it for you). A request
// refused with RECENT_MFA_REQUIRED or MFA_STEP_UP_REQUIRED opens this dialog
// with the shared MfaCodeForm, calls POST /api/auth/mfa/step-up and is then
// retried once.

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import MfaCodeForm from "@/components/auth/MfaCodeForm";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { accountSecurity, type Factor } from "@/lib/account-security.service";
import { inspectHttpError } from "@/lib/error-messages";
import { MfaStepUpContext, stepUpCancelledError, type MfaStepUpController } from "@/lib/mfa-step-up";

export { useMfaStepUp, runWithStepUp, type MfaStepUp } from "@/lib/mfa-step-up";

/** User-facing text for POST /api/auth/mfa/step-up failures. */
export function stepUpFailureMessage(error: unknown): string {
  const details = inspectHttpError(error);
  switch (details.responseCode) {
    case "MFA_CODE_INVALID":
      return "That code is not valid or was already used. Wait for the next code and try again.";
    case "MFA_LOCKED":
      return "Too many incorrect codes. Two-factor verification is locked for a while; try again later.";
    case "MFA_NOT_ENROLLED":
      return "Two-factor authentication is not set up for your account yet.";
    case "AUTH_SCHEMA_NOT_READY":
      return "Two-factor verification is not available on this server yet.";
  }
  if (details.status === 429) return "Too many attempts. Wait a moment and try again.";
  if (!details.hasResponse) return "The server could not be reached. Check your connection and try again.";
  return details.message || "The code could not be verified. Try again.";
}

export interface MfaStepUpDialogProps {
  open: boolean;
  title?: string;
  description?: string;
  /** Called after POST /api/auth/mfa/step-up succeeded. */
  onVerified: () => void;
  /** Called when the dialog is dismissed without verifying. */
  onCancel: () => void;
}

/** The dialog alone (controlled). Most callers want MfaStepUpProvider instead. */
export function MfaStepUpDialog({
  open,
  title = "Confirm it's you",
  description = "This product action needs a recent confirmation. Enter the 6-digit code from your authenticator app.",
  onVerified,
  onCancel,
}: MfaStepUpDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notEnrolled, setNotEnrolled] = useState(false);

  const submit = async (factor: Factor) => {
    setBusy(true);
    setError(null);
    try {
      await accountSecurity.stepUp(factor);
      setNotEnrolled(false);
      onVerified();
    } catch (err) {
      setNotEnrolled(inspectHttpError(err).responseCode === "MFA_NOT_ENROLLED");
      setError(stepUpFailureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          setError(null);
          setNotEnrolled(false);
          onCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {open && (
          <MfaCodeForm
            title={title}
            description={description}
            submitLabel="Confirm"
            busy={busy}
            error={error}
            onSubmit={submit}
            onCancel={busy ? undefined : () => { setError(null); setNotEnrolled(false); onCancel(); }}
          />
        )}
        {notEnrolled && (
          <Link href="/dashboard/settings?tab=account-security" className="text-[12px] font-semibold text-primary underline">
            Set up two-factor authentication
          </Link>
        )}
      </DialogContent>
    </Dialog>
  );
}

export interface MfaStepUpProviderProps {
  children: ReactNode;
  /** Dialog heading (default "Confirm it's you"). */
  title?: string;
  /** Dialog explanation. */
  description?: string;
}

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

/**
 * Provides useMfaStepUp() to its subtree and renders the single shared
 * step-up dialog. Concurrent requests that need a step-up share one dialog.
 */
export function MfaStepUpProvider({ children, title, description }: MfaStepUpProviderProps) {
  const [open, setOpen] = useState(false);
  const waiters = useRef<Waiter[]>([]);

  const settle = useCallback((ok: boolean) => {
    const pending = waiters.current;
    waiters.current = [];
    setOpen(false);
    for (const w of pending) {
      if (ok) w.resolve();
      else w.reject(stepUpCancelledError());
    }
  }, []);

  const requestStepUp = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        waiters.current.push({ resolve, reject });
        setOpen(true);
      }),
    [],
  );

  const controller = useMemo<MfaStepUpController>(() => ({ requestStepUp }), [requestStepUp]);

  return (
    <MfaStepUpContext.Provider value={controller}>
      {children}
      <MfaStepUpDialog open={open} title={title} description={description} onVerified={() => settle(true)} onCancel={() => settle(false)} />
    </MfaStepUpContext.Provider>
  );
}
