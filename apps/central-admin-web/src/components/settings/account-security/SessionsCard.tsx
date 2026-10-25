"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@/stores/auth.store";
import { accountSecurity, errorMessage, type ActiveSession } from "@/lib/account-security.service";

function describe(session: ActiveSession) {
  const agent = session.userAgent || "Unknown device";
  const browser = /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Firefox\//.test(agent) ? "Firefox" : /Safari\//.test(agent) ? "Safari" : "Browser";
  return `${browser}${session.ipAddress ? ` · ${session.ipAddress}` : ""}`;
}

export default function SessionsCard() {
  const { logout } = useAuthStore();
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await accountSecurity.listSessions());
    } catch (err) {
      setError(errorMessage(err, "Could not load sessions."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (session: ActiveSession) => {
    setBusyId(session.id);
    try {
      await accountSecurity.revokeSession(session.id);
      if (session.current) await logout();
      else await load();
    } catch (err) {
      setError(errorMessage(err, "Could not end the session."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6 flex flex-col gap-4" aria-labelledby="sessions-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="sessions-heading" className="text-[15px] font-poppins font-semibold text-foreground">
            Where you&apos;re signed in
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground">End any session you don&apos;t recognise.</p>
        </div>
        <button
          type="button"
          className="h-[36px] px-4 border border-border text-[13px] font-poppins rounded-lg hover:bg-muted"
          onClick={async () => {
            try {
              await accountSecurity.logoutAll();
            } finally {
              await logout();
            }
          }}
        >
          Sign out everywhere
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[12px] font-poppins text-red-500">
          {error}
        </p>
      )}
      {sessions && sessions.length === 0 && <p className="text-[13px] font-poppins text-muted-foreground">No other sessions.</p>}
      <ul className="flex flex-col divide-y divide-border">
        {sessions?.map((session) => (
          <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="session-row">
            <div className="flex flex-col">
              <span className="text-[13px] font-poppins text-foreground">
                {describe(session)} {session.current && <span className="ml-1 rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary">This device</span>}
              </span>
              <span className="text-[12px] font-poppins text-muted-foreground">
                Signed in {new Date(session.createdAt).toLocaleString()} · last active {new Date(session.lastSeenAt).toLocaleString()}
                {session.mfaVerifiedAt ? " · verified with two-factor" : ""}
              </span>
            </div>
            <button
              type="button"
              disabled={busyId === session.id}
              onClick={() => void revoke(session)}
              className="h-[32px] px-3 text-[12px] font-poppins text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-60"
            >
              {session.current ? "Sign out" : "End session"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
