"use client";

import { BarChart3 } from "lucide-react";
import { EmCard } from "./em-ui";

/** Honest analytics placeholder: no campaign has been dispatched in M6. */
export default function AnalyticsFoundation() {
  return (
    <EmCard title="Campaign analytics" id="em-analytics">
      <div role="status" className="flex items-start gap-3 text-[12px] text-muted-foreground">
        <BarChart3 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold text-foreground">No delivery data yet</p>
          <p>
            Campaign dispatch is not enabled in this release, so there are no sends, deliveries, opens, clicks, bounces or
            unsubscribes to report. Metrics will appear here only from real provider events once dispatch (M7) is approved.
          </p>
        </div>
      </div>
    </EmCard>
  );
}
