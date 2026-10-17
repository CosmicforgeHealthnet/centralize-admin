"use client";

import { useEffect } from "react";
import { ArrowLeft, AlertCircle, ImageOff } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import DataSufficiencyBadge from "@/components/marketing/shared/DataSufficiencyBadge";
import FatigueBadge from "@/components/marketing/shared/FatigueBadge";
import ScoreGauge from "@/components/marketing/shared/ScoreGauge";
import EvidencePanel from "@/components/marketing/shared/EvidencePanel";
import MetricCard from "@/components/marketing/shared/MetricCard";

interface CreativeDetailPageProps {
  id: string;
  onBack: () => void;
}

function fmtMoney(v: number | null, currency: string | null) {
  if (v === null) return null;
  return `${currency ?? ""} ${v.toLocaleString()}`;
}
function fmtPct(v: number | null) {
  if (v === null) return null;
  return `${(v * 100).toFixed(2)}%`;
}

export default function CreativeDetailPage({ id, onBack }: CreativeDetailPageProps) {
  const { creativeDetail, isLoadingCreativeDetail, error, fetchCreativeDetail } = useAIMarketingIntelligenceStore();

  useEffect(() => {
    fetchCreativeDetail(id);
  }, [id, fetchCreativeDetail]);

  if (isLoadingCreativeDetail && !creativeDetail) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-8 w-32 rounded bg-muted animate-pulse" />
        <div className="h-40 rounded-[10px] bg-muted animate-pulse" />
        <div className="h-40 rounded-[10px] bg-muted animate-pulse" />
      </div>
    );
  }

  if (error && !creativeDetail) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Creative Library
        </button>
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!creativeDetail) return null;
  const c = creativeDetail;

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Creative Library
      </button>

      {/* Header */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col sm:flex-row sm:items-start gap-4">
        <div className="w-full sm:w-40 h-28 rounded-[8px] bg-muted flex items-center justify-center shrink-0 overflow-hidden">
          {c.mediaPreviewAvailable && c.mediaPreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.mediaPreviewUrl} alt={c.name} className="w-full h-full object-cover" />
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground">
              <ImageOff className="w-5 h-5" strokeWidth={1.5} />
              <span className="font-poppins text-[10px]">No preview</span>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-poppins text-[15px] font-semibold text-foreground">{c.name}</h2>
              <p className="font-poppins text-[11px] text-muted-foreground mt-0.5">
                {c.type} · {c.providerStatus ?? "Unknown status"}
              </p>
            </div>
            <ProviderBadge provider={c.platform as BadgeProvider} subtitle={c.accountLabel ?? undefined} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <DataSufficiencyBadge value={c.dataSufficiency} />
            <FatigueBadge value={c.fatigueStatus} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 pt-1 text-[11px] font-poppins text-muted-foreground">
            <span>Account: {c.nativeIdentifiers.account || "—"}</span>
            <span>Campaign: {c.nativeIdentifiers.campaign || "—"}</span>
            <span>Ad group: {c.nativeIdentifiers.adGroup || "—"}</span>
            <span>Ad: {c.nativeIdentifiers.ad || "—"}</span>
          </div>
        </div>
      </div>

      {/* Primary vs comparison window performance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">
            Primary window ({c.primaryWindow.from} → {c.primaryWindow.to})
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <MetricCard label="Spend" value={fmtMoney(c.primaryWindow.spend, c.currency)} />
            <MetricCard label="Impressions" value={c.primaryWindow.impressions} />
            <MetricCard label="Clicks" value={c.primaryWindow.clicks} />
            <MetricCard label="CTR" value={fmtPct(c.primaryWindow.ctr)} />
            <MetricCard label="CPA" value={fmtMoney(c.primaryWindow.cpa, c.currency)} />
            <MetricCard label="ROAS" value={c.primaryWindow.roas} />
          </div>
        </div>

        <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">
            Comparison window ({c.comparisonWindow.from} → {c.comparisonWindow.to})
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <MetricCard label="Spend" value={fmtMoney(c.comparisonWindow.spend, c.currency)} />
            <MetricCard label="Impressions" value={c.comparisonWindow.impressions} />
            <MetricCard label="Clicks" value={c.comparisonWindow.clicks} />
            <MetricCard label="CTR" value={fmtPct(c.comparisonWindow.ctr)} />
            <MetricCard label="CPA" value={fmtMoney(c.comparisonWindow.cpa, c.currency)} />
            <MetricCard label="ROAS" value={c.comparisonWindow.roas} />
          </div>
        </div>
      </div>

      {/* Score */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-4">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">Score</h3>

        {!c.latestScoreDetail ? (
          <p className="font-poppins text-[12px] text-muted-foreground italic">
            Below data-sufficiency threshold — no numeric score shown.
          </p>
        ) : (
          <div className="flex flex-col sm:flex-row gap-5">
            <div className="flex flex-col items-center gap-2 shrink-0">
              <ScoreGauge score={c.latestScoreDetail.score} dataSufficiency={c.latestScoreDetail.dataSufficiency} />
              <span className="font-poppins text-[10px] text-muted-foreground text-center max-w-[100px]">
                {c.latestScoreDetail.peerBasis}
              </span>
            </div>

            <div className="flex-1 flex flex-col gap-2">
              {c.latestScoreDetail.components.map((comp) => (
                <div key={comp.key} className="flex items-center justify-between gap-3">
                  <span className="font-poppins text-[11px] text-foreground">{comp.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-poppins text-[11px] text-muted-foreground">
                      {comp.appliedWeight === null
                        ? "Not included"
                        : `${(comp.appliedWeight * 100).toFixed(0)}% weight`}
                    </span>
                    <span className="font-poppins text-[11px] font-medium text-foreground w-10 text-right">
                      {comp.value !== null ? comp.value.toFixed(2) : "—"}
                    </span>
                  </div>
                </div>
              ))}
              <p className="font-poppins text-[10px] text-muted-foreground pt-1">
                Rule {c.latestScoreDetail.ruleVersion} · Generated {new Date(c.latestScoreDetail.generatedAt).toLocaleString()}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Fatigue evidence */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Fatigue Evidence</h3>
          <FatigueBadge value={c.fatigueEvidence.status} />
        </div>

        {!c.fatigueEvidence.volumeGateMet && (
          <p className="font-poppins text-[11px] text-muted-foreground italic">
            Volume gate not met — insufficient data to classify fatigue for this creative.
          </p>
        )}

        <EvidencePanel
          rows={[
            { label: "Primary signal", value: c.fatigueEvidence.primarySignal },
            { label: "Confirming signal", value: c.fatigueEvidence.confirmingSignal },
            { label: "Persistence count", value: c.fatigueEvidence.persistenceCount },
            { label: "Recent CTR", value: fmtPct(c.fatigueEvidence.recentWindow.ctr) },
            { label: "Comparison CTR", value: fmtPct(c.fatigueEvidence.comparisonWindow.ctr) },
          ]}
        />

        {c.fatigueEvidence.recoveryHistory.length > 0 && (
          <div className="flex flex-col gap-1 pt-1">
            <span className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Recovery history
            </span>
            {c.fatigueEvidence.recoveryHistory.map((r, i) => (
              <p key={i} className="font-poppins text-[11px] text-foreground">
                {new Date(r.recoveredAt).toLocaleDateString()} — {r.note}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Copy */}
      {c.copy && (
        <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-2">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Copy & Metadata</h3>
          {c.copy.headline && <p className="font-poppins text-[12px] text-foreground"><strong>Headline:</strong> {c.copy.headline}</p>}
          {c.copy.body && <p className="font-poppins text-[12px] text-foreground"><strong>Body:</strong> {c.copy.body}</p>}
          {c.copy.cta && <p className="font-poppins text-[12px] text-foreground"><strong>CTA:</strong> {c.copy.cta}</p>}
        </div>
      )}
    </div>
  );
}