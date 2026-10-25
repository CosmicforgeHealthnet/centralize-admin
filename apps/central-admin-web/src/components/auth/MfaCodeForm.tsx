"use client";

import { useState } from "react";

interface MfaCodeFormProps {
  title?: string;
  description?: string;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  allowRecoveryCode?: boolean;
  onSubmit: (input: { code?: string; recoveryCode?: string }) => void | Promise<void>;
  onCancel?: () => void;
}

// Authenticator code (6 digits) with an optional recovery-code fallback.
export default function MfaCodeForm({
  title = "Two-factor authentication",
  description = "Enter the 6-digit code from your authenticator app.",
  submitLabel = "Verify",
  busy = false,
  error = null,
  allowRecoveryCode = true,
  onSubmit,
  onCancel,
}: MfaCodeFormProps) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");

  const valid = useRecovery ? value.replace(/[^A-Za-z0-9]/g, "").length === 10 : /^\d{6}$/.test(value);

  const submit = () => {
    if (!valid || busy) return;
    void onSubmit(useRecovery ? { recoveryCode: value.trim() } : { code: value.trim() });
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      aria-labelledby="mfa-title"
    >
      <div className="flex flex-col gap-1">
        <h2 id="mfa-title" className="text-[15px] font-poppins font-semibold text-foreground">{title}</h2>
        <p className="text-[12px] font-poppins text-muted-foreground">
          {useRecovery ? "Enter one of your recovery codes. Each code works once." : description}
        </p>
      </div>
      <label htmlFor="mfa-code" className="sr-only">
        {useRecovery ? "Recovery code" : "Authentication code"}
      </label>
      <input
        id="mfa-code"
        autoFocus
        autoComplete="one-time-code"
        inputMode={useRecovery ? "text" : "numeric"}
        maxLength={useRecovery ? 16 : 6}
        value={value}
        onChange={(e) => setValue(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ""))}
        placeholder={useRecovery ? "XXXXX-XXXXX" : "123456"}
        className="h-[44px] px-3 rounded-lg bg-muted border border-border text-[15px] tracking-[0.3em] font-mono text-foreground outline-none focus:border-primary"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "mfa-error" : undefined}
      />
      {error && (
        <p id="mfa-error" role="alert" className="text-[12px] font-poppins text-red-500">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!valid || busy}
          className="h-[40px] px-6 bg-primary text-white text-[13px] font-poppins font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy ? "Checking..." : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-[40px] px-4 text-[13px] font-poppins text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        )}
        {allowRecoveryCode && (
          <button
            type="button"
            onClick={() => {
              setUseRecovery((r) => !r);
              setValue("");
            }}
            className="text-[12px] font-poppins text-primary underline underline-offset-2"
          >
            {useRecovery ? "Use authenticator code" : "Use a recovery code"}
          </button>
        )}
      </div>
    </form>
  );
}
