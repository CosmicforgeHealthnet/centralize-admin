"use client";

// Final gap 3: estimated spend, provider quota and the delayed-event window
// of one campaign report. Every amount is an estimate from approved pricing;
// actual billed spend is never available (the provider has no billing API).

import { formatFullDate } from "@/components/mail/mail-utils";
import type { BroadcastReport, ProviderQuotaSnapshot, ReportSpend } from "@/types/mail-marketing.types";

function quotaLine(quota: ProviderQuotaSnapshot) {
  const used = (value: number | null | undefined, limit: number | null | undefined) =>
    `${value ?? "unknown"}${limit != null ? ` of ${limit}` : " (limit unknown)"}`;
  return `Today ${used(quota.dailyUsed, quota.dailyLimit)} · this month ${used(quota.monthlyUsed, quota.monthlyLimit)}`;
}

function SpendBlock({ spend }: { spend: ReportSpend }) {
  if (spend.status !== "ESTIMATED") {
    return (
      <p className="text-muted-foreground" data-testid="campaign-spend">
        Estimated cost: <strong className="text-foreground">unavailable</strong>. {spend.reason}
      </p>
    );
  }
  return (
    <div data-testid="campaign-spend">
      <p>
        Estimated cost: <strong>{spend.currency} {spend.amount}</strong>{" "}
        <span className="text-muted-foreground">({spend.label})</span>
      </p>
      <p className="text-muted-foreground">
        {spend.basisCount} recipient(s) accepted by the provider × {spend.currency} {spend.unitCost} per email · pricing {spend.pricingSource?.toLowerCase().replace(/_/g, " ")} &ldquo;{spend.pricingReference}&rdquo;
        {spend.pricingEffectiveFrom ? `, effective ${formatFullDate(spend.pricingEffectiveFrom)}` : ""}
        {spend.computedAt ? ` · computed ${formatFullDate(spend.computedAt)}` : ""}. The estimate does not change when pricing changes later.
      </p>
      {spend.includedAllowanceNote && <p className="text-muted-foreground">{spend.includedAllowanceNote}</p>}
    </div>
  );
}

export default function CampaignCostPanel({ report }: { report: BroadcastReport }) {
  const { spend, providerQuota, denominators } = report;
  if (!spend && !providerQuota && !denominators) return null;
  return (
    <section aria-labelledby="cd-cost" className="mt-2 border-t border-border pt-3">
      <h3 id="cd-cost" className="mb-1 font-semibold">Cost and provider quota</h3>
      {spend && <SpendBlock spend={spend} />}
      {spend && <p className="text-muted-foreground">Billed spend: not available. {spend.billedReason}</p>}
      {denominators?.eventsStillArriving && (
        <p role="status" className="mt-1 text-amber-700" data-testid="events-still-arriving">
          Delivery events are still arriving
          {denominators.eventsSettleUntil ? ` (until about ${formatFullDate(denominators.eventsSettleUntil)})` : ""}; figures may still change.
        </p>
      )}
      {denominators?.reportWindowEnd && (
        <p className="text-muted-foreground">Report window ends {formatFullDate(denominators.reportWindowEnd)}.</p>
      )}
      {providerQuota && (
        <div className="mt-1" data-testid="campaign-quota">
          {providerQuota.status === "HIDDEN" || providerQuota.status === "UNAVAILABLE" ? (
            <p className="text-muted-foreground">Provider quota: {providerQuota.reason}</p>
          ) : (
            <p className="text-muted-foreground">
              Provider quota ({providerQuota.scope}): {providerQuota.status === "UNKNOWN" ? "not observed yet" : quotaLine(providerQuota)}
              {providerQuota.exhausted ? ` · exhausted until ${formatFullDate(providerQuota.exhaustedUntil ?? "")}` : ""}
              {providerQuota.observedAt ? ` · observed ${formatFullDate(providerQuota.observedAt)}` : ""}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
