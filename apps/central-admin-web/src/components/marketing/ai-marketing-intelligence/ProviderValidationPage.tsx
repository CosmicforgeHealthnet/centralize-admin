"use client";

import { useEffect } from "react";
import { ShieldCheck, AlertCircle, CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import ValidationStatusBadge from "@/components/marketing/shared/ValidationStatusBadge";
import EmptyState from "@/components/marketing/shared/EmptyState";

function ChecklistIcon({ passed }: { passed: boolean | null }) {
  if (passed === null) return <MinusCircle className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" strokeWidth={2} />;
  if (passed) return <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" strokeWidth={2} />;
  return <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" strokeWidth={2} />;
}

export default function ProviderValidationPage() {
  const { providerValidation, isLoadingProviderValidation, error, fetchProviderValidation } =
    useAIMarketingIntelligenceStore();

  useEffect(() => {
    fetchProviderValidation();
  }, [fetchProviderValidation]);

  if (isLoadingProviderValidation && providerValidation.length === 0) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-56 rounded-[10px] bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (error && providerValidation.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
        <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
        <p className="font-poppins text-[12px] text-red-700">{error}</p>
      </div>
    );
  }

  if (providerValidation.length === 0) {
    return <EmptyState message="No provider validation data" description="Connect a provider to begin validation." />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-primary" strokeWidth={2} />
        <div>
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">Provider Validation</h2>
          <p className="font-poppins text-[11px] text-muted-foreground">
            Read-oriented readiness matrix separating code capability, connection configuration and live validation.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {providerValidation.map((row) => (
          <div key={row.platform} className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <ProviderBadge provider={row.platform as BadgeProvider} />
              <ValidationStatusBadge value={row.status} />
            </div>

            {row.blocker && (
              <p className="font-poppins text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-[6px] px-2.5 py-1.5">
                {row.blocker}
              </p>
            )}

            <div className="flex flex-col gap-1.5 pt-1">
              <span className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Validation checklist
              </span>
              {row.checklist.map((item) => (
                <div key={item.label} className="flex items-center gap-2">
                  <ChecklistIcon passed={item.passed} />
                  <span
                    className={`font-poppins text-[11px] ${
                      item.passed === null ? "text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {item.label}
                  </span>
                </div>
              ))}
            </div>

            {row.connections.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-2 border-t border-border/70">
                <span className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Connections
                </span>
                {row.connections.map((c) => (
                  <div key={c.id} className="flex items-center justify-between">
                    <span className="font-poppins text-[11px] text-foreground truncate">
                      {c.accountLabel ?? c.id}
                    </span>
                    <span className="font-poppins text-[10px] text-muted-foreground">{c.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}