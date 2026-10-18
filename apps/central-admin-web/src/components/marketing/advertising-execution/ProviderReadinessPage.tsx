"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle } from "lucide-react";
import { fetchAECapabilities } from "@/lib/advertising-execution.service";
import type { AEProviderCapability } from "@/types/advertising-execution.types";

function ValidationBadge({ status }: { status: AEProviderCapability["liveValidationStatus"] }) {
  const isLive = status === "LIVE_VALIDATED";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-poppins text-[10px] font-medium ${
        isLive ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground border border-border"
      }`}
    >
      {isLive ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
      {isLive ? "Live validated" : "Not live validated"}
    </span>
  );
}

function ConnectionStatusDot({ status }: { status: AEProviderCapability["connectionStatus"] }) {
  const color =
    status === "CONNECTED" ? "bg-emerald-500" : status === "DEGRADED" ? "bg-amber-500" : "bg-muted-foreground/40";
  return <span className={`w-1.5 h-1.5 rounded-full ${color}`} />;
}

export default function ProviderReadinessPage() {
  const [capabilities, setCapabilities] = useState<AEProviderCapability[] | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchAECapabilities().then((res) => {
      if (mounted) setCapabilities(res);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!capabilities) {
    return (
      <div className="flex flex-col gap-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-24 rounded-[10px] bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {capabilities.map((cap) => (
        <div key={cap.provider} className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <ConnectionStatusDot status={cap.connectionStatus} />
              <span className="font-poppins text-[13px] font-semibold text-foreground">{cap.provider}</span>
              {cap.apiVersion && (
                <span className="font-poppins text-[11px] text-muted-foreground">API {cap.apiVersion}</span>
              )}
            </div>
            <ValidationBadge status={cap.liveValidationStatus} />
          </div>

          {cap.connectionId ? (
            <div className="grid grid-cols-2 min-[600px]:grid-cols-4 gap-3">
              <div className="flex flex-col">
                <span className="font-poppins text-[10px] text-muted-foreground">Connection</span>
                <span className="font-poppins text-[12px] text-foreground">{cap.connectionLabel}</span>
              </div>
              <div className="flex flex-col">
                <span className="font-poppins text-[10px] text-muted-foreground">Account</span>
                <span className="font-poppins text-[12px] text-foreground">{cap.accountLabel ?? "—"}</span>
              </div>
              <div className="flex flex-col">
                <span className="font-poppins text-[10px] text-muted-foreground">Currency</span>
                <span className="font-poppins text-[12px] text-foreground">{cap.accountCurrency ?? "—"}</span>
              </div>
              <div className="flex flex-col">
                <span className="font-poppins text-[10px] text-muted-foreground">Credential</span>
                <span className="font-poppins text-[12px] text-foreground">
                  {cap.credentialPresent ? "Present" : "Absent"}
                </span>
              </div>
            </div>
          ) : (
            <p className="font-poppins text-[12px] text-muted-foreground">No connection configured for this provider.</p>
          )}

          {cap.supportedResourceTypes.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {cap.supportedResourceTypes.map((rt) => (
                <span
                  key={rt}
                  className="rounded-full bg-muted px-2 py-0.5 font-poppins text-[10px] text-muted-foreground"
                >
                  {rt}
                </span>
              ))}
            </div>
          )}

          {cap.blockers.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {cap.blockers.map((b, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                  <span className="font-poppins text-[11px] text-amber-700">{b.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}