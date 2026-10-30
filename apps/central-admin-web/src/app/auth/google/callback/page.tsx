"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthStore } from "@/stores/auth.store";
import { applySessionPayload, clearSessionState } from "@/lib/auth-session";
import MfaCodeForm from "@/components/auth/MfaCodeForm";
import api from "@/lib/api";

const FAILED = "/?error=Google+login+failed.+No+admin+account+found.";

function GoogleCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { hydrateFromSession, startCookieMfaChallenge, completeMfa, isLoading, error } = useAuthStore();
  const [needsMfa, setNeedsMfa] = useState(false);

  useEffect(() => {
    const token = searchParams.get("token");
    // dual/cookie mode: credentials are already httpOnly cookies.
    if (searchParams.get("session") === "1") {
      hydrateFromSession().then((ok) => router.replace(ok ? "/dashboard" : FAILED));
      return;
    }
    // MFA-enrolled user: the challenge is in an httpOnly cookie, never the URL.
    if (searchParams.get("mfa") === "1") {
      startCookieMfaChallenge();
      setNeedsMfa(true);
      return;
    }
    if (!token) {
      router.replace("/");
      return;
    }

    // Legacy mode (unchanged contract).
    applySessionPayload({ accessToken: token, session: { mode: "legacy" } });
    window.history.replaceState(null, "", window.location.pathname);
    api
      .get("/api/auth/me")
      .then((res) => {
        useAuthStore.setState({
          user: res.data.data,
          accessToken: token,
          mustChangePassword: false,
          isLoading: false,
          error: null,
        });
        router.replace("/dashboard");
      })
      .catch(() => {
        clearSessionState();
        router.replace(FAILED);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (needsMfa) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-[420px] bg-card rounded-xl border border-border p-6">
          <MfaCodeForm
            busy={isLoading}
            error={error}
            submitLabel="Sign in"
            onSubmit={async (input) => {
              await completeMfa(input);
              if (useAuthStore.getState().user && !useAuthStore.getState().error) router.replace("/dashboard");
            }}
            onCancel={() => router.replace("/")}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground text-sm">Signing you in with Google...</p>
    </div>
  );
}

export default function GoogleCallbackPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">Signing you in with Google...</p>
      </div>
    }>
      <GoogleCallbackInner />
    </Suspense>
  );
}
