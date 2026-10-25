"use client";

import { useCallback, useEffect, useState } from "react";
import MfaCodeForm from "@/components/auth/MfaCodeForm";
import { accountSecurity, errorCode, errorMessage, type EnrollmentStart, type MfaStatus } from "@/lib/account-security.service";

const inputClass =
  "h-[40px] px-3 rounded-lg bg-muted border border-border text-[13px] font-poppins text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors";
const primaryButton =
  "h-[40px] px-6 bg-primary text-white text-[13px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed";
const secondaryButton =
  "h-[40px] px-4 border border-border text-[13px] font-poppins rounded-lg hover:bg-muted transition-colors disabled:opacity-60";

type Step =
  | { kind: "idle" }
  | { kind: "password" }
  | { kind: "scan"; enrollment: EnrollmentStart }
  | { kind: "codes"; codes: string[] }
  | { kind: "stepUp"; then: "regenerate" }
  | { kind: "disable" };

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const download = () => {
    const blob = new Blob([`CosmicForge HQ recovery codes\nGenerated ${new Date().toISOString()}\nEach code works once.\n\n${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "cosmicforge-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="recovery-codes">
      <p className="text-[13px] font-poppins font-semibold text-foreground">Save your recovery codes</p>
      <p className="text-[12px] font-poppins text-muted-foreground">
        Use one of these if you lose your authenticator. Each works once. They will not be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-3 font-mono text-[13px]" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-3">
        <button type="button" className={secondaryButton} onClick={download}>
          Download
        </button>
        <button type="button" className={secondaryButton} onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}>
          Copy
        </button>
        <button type="button" className={primaryButton} onClick={onDone}>
          I have saved them
        </button>
      </div>
    </div>
  );
}

export default function TwoFactorCard() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await accountSecurity.mfaStatus());
    } catch (err) {
      setError(errorMessage(err, "Could not load two-factor status."));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = () =>
    run(async () => {
      try {
        const { recoveryCodes } = await accountSecurity.regenerateRecoveryCodes();
        setStep({ kind: "codes", codes: recoveryCodes });
      } catch (err) {
        if (errorCode(err) === "MFA_STEP_UP_REQUIRED") setStep({ kind: "stepUp", then: "regenerate" });
        else throw err;
      }
    }, "Could not generate new codes.");

  return (
    <div className="bg-card rounded-xl border border-border p-6 flex flex-col gap-5" aria-labelledby="two-factor-heading">
      <div className="flex flex-col gap-0.5">
        <h2 id="two-factor-heading" className="text-[15px] font-poppins font-semibold text-foreground">
          Two-factor authentication
        </h2>
        <p className="text-[12px] font-poppins text-primary">
          Required for privileged actions such as Mail break-glass access, marketing approvals and emergency overrides.
        </p>
      </div>

      {status && !status.available && !status.enrolled && (
        <p className="text-[12px] font-poppins text-amber-700" role="status">
          Two-factor authentication is not configured on this server yet. Contact the platform team.
        </p>
      )}

      {status && step.kind === "idle" && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] font-poppins text-foreground" data-testid="mfa-state">
            {status.enrolled ? `On since ${new Date(status.enrolledAt as string).toLocaleDateString()}` : "Off"}
            {status.enrolled && ` · ${status.recoveryCodesRemaining} recovery codes left`}
          </p>
          <div className="flex flex-wrap gap-3">
            {!status.enrolled && (
              <button type="button" className={primaryButton} disabled={!status.available} onClick={() => setStep({ kind: "password" })}>
                Set up two-factor authentication
              </button>
            )}
            {status.enrolled && (
              <>
                <button type="button" className={secondaryButton} disabled={busy} onClick={regenerate}>
                  New recovery codes
                </button>
                <button type="button" className={secondaryButton} onClick={() => setStep({ kind: "disable" })}>
                  Turn off
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {step.kind === "password" && (
        <form
          className="flex flex-col gap-3 max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const enrollment = await accountSecurity.startEnrollment(password);
              setPassword("");
              setStep({ kind: "scan", enrollment });
            }, "Could not start setup.");
          }}
        >
          <label htmlFor="mfa-password" className="text-[13px] font-poppins text-foreground">
            Confirm your password
          </label>
          <input id="mfa-password" type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="flex gap-3">
            <button type="submit" className={primaryButton} disabled={!password || busy}>
              Continue
            </button>
            <button type="button" className={secondaryButton} onClick={() => setStep({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {step.kind === "scan" && (
        <div className="flex flex-col gap-4">
          <ol className="list-decimal pl-5 text-[13px] font-poppins text-foreground flex flex-col gap-2">
            <li>
              Open your authenticator app and add an account. On a phone, you can{" "}
              <a className="text-primary underline" href={step.enrollment.otpauthUri}>
                open this setup link
              </a>
              .
            </li>
            <li>
              Or enter this key manually:{" "}
              <code className="rounded bg-muted px-2 py-1 font-mono text-[13px] break-all" data-testid="mfa-secret">
                {step.enrollment.secret.replace(/(.{4})/g, "$1 ").trim()}
              </code>
            </li>
            <li>Enter the 6-digit code it shows to finish.</li>
          </ol>
          <MfaCodeForm
            title="Confirm setup"
            submitLabel="Turn on"
            allowRecoveryCode={false}
            busy={busy}
            error={error}
            onSubmit={({ code }) =>
              run(async () => {
                const { recoveryCodes } = await accountSecurity.activate(code as string);
                setStep({ kind: "codes", codes: recoveryCodes });
                await refresh();
              }, "The code is not valid.")
            }
            onCancel={() => setStep({ kind: "idle" })}
          />
        </div>
      )}

      {step.kind === "codes" && (
        <RecoveryCodes
          codes={step.codes}
          onDone={() => {
            setStep({ kind: "idle" });
            setNotice("Two-factor authentication is on.");
            void refresh();
          }}
        />
      )}

      {step.kind === "stepUp" && (
        <MfaCodeForm
          title="Confirm it's you"
          description="Enter a code from your authenticator app to continue."
          busy={busy}
          error={error}
          onSubmit={(factor) =>
            run(async () => {
              await accountSecurity.stepUp(factor);
              setStep({ kind: "idle" });
              await regenerate();
            }, "The code is not valid.")
          }
          onCancel={() => setStep({ kind: "idle" })}
        />
      )}

      {step.kind === "disable" && (
        <div className="flex flex-col gap-3 max-w-sm">
          <label htmlFor="mfa-disable-password" className="text-[13px] font-poppins text-foreground">
            Password
          </label>
          <input id="mfa-disable-password" type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />
          <MfaCodeForm
            title="Turn off two-factor authentication"
            description="You will be signed out of your other sessions."
            submitLabel="Turn off"
            busy={busy}
            error={error}
            onSubmit={(factor) =>
              run(async () => {
                await accountSecurity.disable(password, factor);
                setPassword("");
                setStep({ kind: "idle" });
                setNotice("Two-factor authentication is off.");
                await refresh();
              }, "Could not turn off two-factor authentication.")
            }
            onCancel={() => setStep({ kind: "idle" })}
          />
        </div>
      )}

      {error && step.kind === "idle" && (
        <p role="alert" className="text-[12px] font-poppins text-red-500">
          {error}
        </p>
      )}
      {notice && step.kind === "idle" && (
        <p role="status" className="text-[12px] font-poppins text-green-600">
          {notice}
        </p>
      )}
    </div>
  );
}
