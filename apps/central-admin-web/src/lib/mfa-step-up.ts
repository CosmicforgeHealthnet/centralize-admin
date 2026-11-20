"use client";

// Session MFA step-up, shared by every product page and mutation.
//
// A request refused with RECENT_MFA_REQUIRED (PIC / Product Admin) or
// MFA_STEP_UP_REQUIRED (HQ gateway) is retried exactly once after the staff
// member confirms with their authenticator (POST /api/auth/mfa/step-up).
// The dialog itself lives in components/products/MfaStepUp.tsx
// (MfaStepUpProvider); this module holds the context and the hook so that
// lib code (React Query hooks) can use it without importing components.

import { createContext, useCallback, useContext, useMemo } from "react";
import { isMfaStepUpRequired, ProductApiError } from "@/lib/products.service";

export interface MfaStepUpController {
  /**
   * Opens the step-up dialog (one dialog is shared by concurrent callers).
   * Resolves once the step-up succeeded; rejects with a ProductApiError
   * (code MFA_STEP_UP_CANCELLED, kind "mfa_required") when the user cancels.
   */
  requestStepUp: () => Promise<void>;
}

export const MfaStepUpContext = createContext<MfaStepUpController | null>(null);

/** Error used when the user closes the step-up dialog without confirming. */
export function stepUpCancelledError(): ProductApiError {
  return new ProductApiError({
    status: null,
    code: "MFA_STEP_UP_CANCELLED",
    reason: "MFA_STEP_UP_CANCELLED",
    source: "client",
    kind: "mfa_required",
    message: "Confirmation with the authenticator app was cancelled",
  });
}

/**
 * Runs `fn`; if it is refused for a missing recent MFA, asks for a step-up and
 * runs `fn` once more. A second refusal (or any other error) is thrown as is:
 * there is never a loop.
 */
export async function runWithStepUp<T>(fn: () => Promise<T>, requestStepUp: () => Promise<void>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isMfaStepUpRequired(err)) throw err;
    await requestStepUp();
    return fn();
  }
}

export interface MfaStepUp {
  /** False when no MfaStepUpProvider is mounted above this component. */
  available: boolean;
  /** Opens the dialog; rejects immediately when no provider is mounted. */
  requestStepUp: () => Promise<void>;
  /** Runs `fn`, stepping up and retrying once on an MFA refusal. Without a provider, errors pass through unchanged. */
  withStepUp: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** Access to the nearest MfaStepUpProvider. */
export function useMfaStepUp(): MfaStepUp {
  const controller = useContext(MfaStepUpContext);
  const requestStepUp = useCallback(
    () => (controller ? controller.requestStepUp() : Promise.reject(stepUpCancelledError())),
    [controller],
  );
  const withStepUp = useCallback(
    <T,>(fn: () => Promise<T>) => (controller ? runWithStepUp(fn, controller.requestStepUp) : fn()),
    [controller],
  );
  return useMemo(() => ({ available: controller !== null, requestStepUp, withStepUp }), [controller, requestStepUp, withStepUp]);
}
