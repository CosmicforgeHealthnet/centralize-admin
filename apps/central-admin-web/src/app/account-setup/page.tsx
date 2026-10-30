"use client";

// Public page for single-use setup / reset links (invitations, HR-approved
// password resets and lab admin onboarding). The link secret arrives in the
// URL fragment, which browsers never send to servers; it is posted once in a
// JSON body and then removed from the address bar.

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LinkInfo = { purpose: "ADMIN_INVITE" | "ADMIN_PASSWORD_RESET" | "LAB_ADMIN_SETUP"; email: string | null; name: string | null; expiresAt: string; loginUrl: string | null };

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const TITLES: Record<LinkInfo["purpose"], string> = {
  ADMIN_INVITE: "Accept your invitation",
  ADMIN_PASSWORD_RESET: "Choose a new password",
  LAB_ADMIN_SETUP: "Set up your lab administrator account",
};

function passwordProblem(value: string) {
  if (value.length < 8) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(value)) return "Password must contain an uppercase letter";
  if (!/[a-z]/.test(value)) return "Password must contain a lowercase letter";
  if (!/[0-9]/.test(value)) return "Password must contain a number";
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(value)) return "Password must contain a special character";
  return "";
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${API}/api/auth/account-setup/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const details = Array.isArray(json?.errors) ? json.errors.map((item: { message?: string }) => item?.message).filter(Boolean) : [];
    throw new Error(details.length ? details.join(". ") : json?.message || "Something went wrong. Please try again.");
  }
  return json?.data;
}

export default function AccountSetupPage() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid" | "done">("loading");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const value = fragment.get("token");
    // Keep the secret out of history, screenshots and copy-pasted URLs.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (!value) {
      setState("invalid");
      setError("This link is incomplete. Open the link from your email again.");
      return;
    }
    setToken(value);
    post("inspect", { token: value })
      .then((data: LinkInfo) => {
        setInfo(data);
        setState("ready");
      })
      .catch((reason: Error) => {
        setState("invalid");
        setError(reason.message);
      });
  }, []);

  const submit = async () => {
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    if (password !== confirm) return setError("Passwords do not match");
    setBusy(true);
    setError("");
    try {
      await post("complete", { token, password });
      setPassword("");
      setConfirm("");
      setState("done");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-4 py-10 sm:px-8">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex justify-center">
          <Image src="/logo.svg" alt="Cosmicforge Healthnet Logo" width={200} height={57} className="object-contain max-w-[160px] sm:max-w-[200px]" />
        </div>
        <h1 className="text-title text-black text-center mb-2">{info ? TITLES[info.purpose] : "Account setup"}</h1>

        {state === "loading" && <p className="text-center text-muted-foreground" role="status">Checking your link…</p>}

        {error && (
          <div role="alert" className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {state === "ready" && info && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p className="text-body-text text-muted-foreground text-center">
              {info.name ? `Hi ${info.name}. ` : ""}Choose a password for {info.email}. This link works once and expires {new Date(info.expiresAt).toLocaleString()}.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input id="new-password" type="password" autoComplete="new-password" className="h-[50px] bg-white" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} aria-describedby="password-help" />
              <p id="password-help" className="text-xs text-muted-foreground">8+ characters, with uppercase, lowercase, a number, and a special character.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <Input id="confirm-password" type="password" autoComplete="new-password" className="h-[50px] bg-white" value={confirm} onChange={(event) => setConfirm(event.target.value)} disabled={busy} />
            </div>
            <Button type="submit" className="w-full text-white" disabled={busy || !password || !confirm}>
              {busy ? "Saving…" : "Set password"}
            </Button>
          </form>
        )}

        {state === "done" && (
          <div role="status" className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 space-y-2">
            <p>Your password is set.</p>
            {info?.loginUrl ? (
              <p>
                Sign in at <a className="underline" href={info.loginUrl}>{info.loginUrl}</a>.
              </p>
            ) : (
              <p>
                <Link className="underline" href="/">Go to sign in</Link>
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
