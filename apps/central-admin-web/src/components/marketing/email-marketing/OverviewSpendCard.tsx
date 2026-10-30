"use client";

// Final gap 3: this brand's estimated (not billed) broadcast spend over the
// last 30 days, from dispatch cost estimates. Never shows other brands.

import { useQuery } from "@tanstack/react-query";
import { fetchMarketingOverview } from "@/lib/mail-marketing.service";
import type { MarketingOrganization } from "@/types/mail-marketing.types";
import { EmCard } from "./em-ui";

export default function OverviewSpendCard({ org }: { org: MarketingOrganization }) {
  // Same query as the analytics card (shared cache).
  const q = useQuery({ queryKey: ["mail", "marketing", org.id, "overview"], queryFn: () => fetchMarketingOverview(org.id), retry: false, refetchInterval: 60000 });
  const spend = q.data?.spend;
  if (!spend) return null;
  return (
    <EmCard title="Estimated spend (last 30 days)" id="ov-spend">
      <div className="text-[12px]" data-testid="overview-spend">
        {!spend.available ? (
          <p className="text-muted-foreground">Cost estimates are available after the latest Mail database update is applied.</p>
        ) : (
          <>
            {(spend.estimated ?? []).length === 0 ? (
              <p className="text-muted-foreground">No estimated broadcast cost in this period.</p>
            ) : (
              <ul>
                {(spend.estimated ?? []).map((row) => (
                  <li key={row.currency} className="flex justify-between border-t border-border py-1">
                    <span>{row.currency} {row.amount}</span>
                    <span className="text-muted-foreground">{row.dispatches} broadcast(s) · {row.acceptedRecipients} accepted recipients</span>
                  </li>
                ))}
              </ul>
            )}
            {(spend.unavailableDispatches ?? 0) > 0 && <p className="mt-1 text-muted-foreground">{spend.unavailableDispatches} broadcast(s) have no estimate: no approved pricing applied at send time.</p>}
            <p className="mt-1 text-muted-foreground">{spend.label}. Billed spend is not available from the provider; included plan allowances are not subtracted.</p>
          </>
        )}
      </div>
    </EmCard>
  );
}
