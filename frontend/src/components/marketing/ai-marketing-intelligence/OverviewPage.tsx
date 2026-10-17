"use client";

import { useEffect } from "react";
import {
  ArrowRight,
  Sparkles,
  Lightbulb,
  Bell,
  AlertCircle,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import EnvironmentPhaseBanner from "@/components/marketing/shared/EnvironmentPhaseBanner";
import ValidationStatusBadge from "@/components/marketing/shared/ValidationStatusBadge";
import RunStatusBadge from "@/components/marketing/shared/RunStatusBadge";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import MetricCard from "@/components/marketing/shared/MetricCard";
import EmptyState from "@/components/marketing/shared/EmptyState";
import type { AMISection } from "./AIMarketingIntelligenceSubNav";

const ROLLOUT_LABELS: Record<string, string> = {
  SCHEMA_DARK_LAUNCH: "1. Schema dark launch",
  INGESTION_OBSERVATION: "2. Ingestion observation",
  SCORING_OBSERVATION: "3. Scoring observation",
  ADVISORY_RECOMMENDATIONS: "4. Advisory recommendations",
  TASK_WORKFLOW: "5. Task workflow",
  FULL_FIVE_PLATFORM_RELEASE: "6. Full five-platform release",
};

function SectionCard({
  icon: Icon,
  title,
  subtitle,
  onViewAll,
  children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle?: string;
  onViewAll?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card rounded-[14px] border border-border p-4 sm:p-5 flex flex-col gap-4 transition-shadow duration-200 hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="flex items-center justify-center w-8 h-8 rounded-[9px] bg-primary/10 shrink-0">
            <Icon className="w-4 h-4 text-primary" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h3 className="font-poppins text-[13.5px] font-semibold text-foreground truncate">{title}</h3>
            {subtitle && <p className="font-poppins text-[11px] text-muted-foreground truncate">{subtitle}</p>}
          </div>
        </div>
        {onViewAll && (
          <button
            onClick={onViewAll}
            className="flex items-center gap-1 font-poppins text-[11px] font-medium text-primary hover:opacity-75 transition-opacity shrink-0 whitespace-nowrap"
          >
            View all
            <ArrowRight className="w-3 h-3" strokeWidth={2.5} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

interface OverviewPageProps {
  onNavigate: (section: AMISection) => void;
}

export default function OverviewPage({ onNavigate }: OverviewPageProps) {
  const { overview, isLoadingOverview, error, fetchOverview } = useAIMarketingIntelligenceStore();

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  if (isLoadingOverview && !overview) {
    return (
      <div className="flex flex-col gap-3.5">
        <div className="h-16 rounded-[14px] bg-muted animate-pulse" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-32 rounded-[14px] bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="flex items-center gap-2.5 rounded-[12px] border border-red-200 bg-red-50 px-4 py-3.5">
        <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
        <p className="font-poppins text-[12px] text-red-700">{error}</p>
      </div>
    );
  }

  if (!overview) return null;

  return (
    <div className="flex flex-col gap-3.5">
      {/* Top status strip */}
      <EnvironmentPhaseBanner environment={overview.environment} phase2State={overview.phase2State} />

      <div className="flex flex-wrap items-center gap-2 text-[11px] font-poppins text-muted-foreground">
        <span className="px-2.5 py-1 rounded-full bg-muted border border-border font-medium text-foreground/80">
          {ROLLOUT_LABELS[overview.rolloutStage] ?? overview.rolloutStage}
        </span>
        <span className="text-muted-foreground/80">
          Last full evaluation:{" "}
          <span className="text-foreground/70">
            {overview.lastSuccessfulFullEvaluationAt
              ? new Date(overview.lastSuccessfulFullEvaluationAt).toLocaleString()
              : "Not available"}
          </span>
        </span>
      </div>

      {/* Provider readiness — stacked rows, never overflows */}
      <SectionCard
        icon={ShieldCheck}
        title="Provider Readiness"
        subtitle="Live-validation state across all five ad platforms"
        onViewAll={() => onNavigate("provider-validation")}
      >
        <div className="flex flex-col divide-y divide-border/70 rounded-[10px] border border-border overflow-hidden">
          {overview.providerReadiness.map((p) => (
            <div
              key={p.platform}
              className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3.5 py-3 hover:bg-muted/30 transition-colors"
            >
              <ProviderBadge provider={p.platform as BadgeProvider} size="sm" />
              <div className="sm:shrink-0">
                <ValidationStatusBadge value={p.status} />
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Creative health */}
      <SectionCard
        icon={Sparkles}
        title="Creative Health"
        subtitle="Data sufficiency and fatigue distribution"
        onViewAll={() => onNavigate("creative-intelligence")}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
          <MetricCard label="Total eligible" value={overview.creativeHealth.totalEligible} />
          <MetricCard label="Insufficient" value={overview.creativeHealth.insufficient} />
          <MetricCard label="Limited" value={overview.creativeHealth.limited} />
          <MetricCard label="Sufficient" value={overview.creativeHealth.sufficient} />
          <MetricCard label="Strong" value={overview.creativeHealth.strong} />
          <MetricCard label="Watch" value={overview.creativeHealth.watch} />
          <MetricCard label="Fatigued" value={overview.creativeHealth.fatigued} />
          <MetricCard
            label="Latest scoring"
            value={
              overview.creativeHealth.latestScoringAt
                ? new Date(overview.creativeHealth.latestScoringAt).toLocaleDateString()
                : null
            }
          />
        </div>
      </SectionCard>

      {/* Recommendation queue */}
      <SectionCard
        icon={Lightbulb}
        title="Recommendation Queue"
        subtitle="Advisory only — never writes to a live account"
        onViewAll={() => onNavigate("recommendations")}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
          {(["PAUSE", "SCALE", "REALLOCATE_BUDGET", "CREATE_CONTENT"] as const).map((type) => (
            <MetricCard
              key={type}
              label={type.replace(/_/g, " ")}
              value={overview.recommendationQueue.pendingByType[type] ?? 0}
            />
          ))}
          <MetricCard label="Accepted, awaiting Task" value={overview.recommendationQueue.acceptedAwaitingTask} />
          <MetricCard label="Expiring soon" value={overview.recommendationQueue.expiringSoon} />
        </div>
      </SectionCard>

      {/* Alert queue */}
      <SectionCard
        icon={Bell}
        title="Alert Queue"
        subtitle="Operational and performance conditions"
        onViewAll={() => onNavigate("alerts")}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
          <MetricCard label="Open critical" value={overview.alertQueue.openCritical} />
          <MetricCard label="Open warning" value={overview.alertQueue.openWarning} />
          <MetricCard label="Open info" value={overview.alertQueue.openInfo} />
          <MetricCard
            label="Oldest unresolved"
            value={
              overview.alertQueue.oldestUnresolvedAt
                ? new Date(overview.alertQueue.oldestUnresolvedAt).toLocaleDateString()
                : null
            }
          />
        </div>
        {overview.alertQueue.notificationSuppressedCount > 0 && (
          <p className="font-poppins text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-[8px] px-3 py-2">
            {overview.alertQueue.notificationSuppressedCount} notification(s) currently suppressed by cooldown
          </p>
        )}
      </SectionCard>

      {/* Recent runs */}
      <SectionCard icon={Clock} title="Recent Evaluation Runs" onViewAll={() => onNavigate("evaluation-runs")}>
        {overview.recentRuns.length === 0 ? (
          <EmptyState message="No recent runs" />
        ) : (
          <div className="flex flex-col divide-y divide-border/70 rounded-[10px] border border-border overflow-hidden">
            {overview.recentRuns.slice(0, 5).map((run) => (
              <div
                key={run.id}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 px-3.5 py-2.5 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-poppins text-[12px] font-medium text-foreground truncate">
                    {run.runType.replace(/_/g, " ")}
                  </span>
                  <span className="font-poppins text-[10px] text-muted-foreground shrink-0">{run.trigger}</span>
                </div>
                <div className="sm:shrink-0">
                  <RunStatusBadge value={run.status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Attention panel */}
      {overview.attention.length > 0 && (
        <SectionCard icon={AlertCircle} title="Needs Attention">
          <div className="flex flex-col gap-2">
            {overview.attention.map((item) => (
              <button
                key={item.key}
                onClick={() => onNavigate(item.linkSection as AMISection)}
                className="flex items-start justify-between gap-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3.5 py-3 text-left hover:bg-amber-100/70 hover:border-amber-300 transition-colors"
              >
                <div className="min-w-0">
                  <p className="font-poppins text-[12px] font-semibold text-amber-800">{item.label}</p>
                  <p className="font-poppins text-[11px] text-amber-700 mt-0.5 leading-relaxed">{item.description}</p>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" strokeWidth={2.5} />
              </button>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}