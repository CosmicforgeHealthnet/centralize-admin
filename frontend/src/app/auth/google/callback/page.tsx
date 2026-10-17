"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthStore } from "@/stores/auth.store";
import api from "@/lib/api";

function GoogleCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const token = searchParams.get("token");

    if (!token) {
      router.replace("/");
      return;
    }

    localStorage.setItem("accessToken", token);

    api
      .get("/api/auth/me")
      .then((res) => {
        const user = res.data.data;
        document.cookie = `accessToken=${token}; path=/; max-age=${8 * 60 * 60}; secure; samesite=strict`;
        useAuthStore.setState({
          user,
          accessToken: token,
          mustChangePassword: false,
          isLoading: false,
          error: null,
        });
        router.replace("/dashboard");
      })
    .catch(() => {
  localStorage.removeItem("accessToken");
  router.replace("/?error=Google+login+failed.+No+admin+account+found.");
});
  }, []);

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