"use client";

import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import { formatFullDate } from "@/components/mail/mail-utils";
import { fetchMarketingOverview } from "@/lib/mail-marketing.service";
import type { MarketingOrganization } from "@/types/mail-marketing.types";
import { EmBadge, EmCard } from "./em-ui";

const pairs = (record: Record<string, number> | undefined) => Object.entries(record ?? {}).filter(([, v]) => v > 0);

/** Brand delivery analytics and marketing worker health, from real provider events only. */
export default function AnalyticsFoundation({ org }: { org: MarketingOrganization }) {
  const q = useQuery({ queryKey: ["mail", "marketing", org.id, "overview"], queryFn: () => fetchMarketingOverview(org.id), retry: false, refetchInterval: 60000 });
  const data = q.data;
  const recipients = pairs(data?.recipientsLast30Days);
  const stuck = (data?.jobs ?? []).filter((j) => ["DEAD_LETTER", "FAILED"].includes(j.status));
  return (
    <>
      <EmCard title="Delivery (last 30 days)" id="em-analytics">
        <PermissionBoundary isLoading={q.isLoading} error={q.error} compact>
          {!data?.flags.broadcastDispatchEnabled && recipients.length === 0 ? (
            <div role="status" className="flex items-start gap-3 text-[12px] text-muted-foreground">
              <BarChart3 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <p>Broadcast dispatch is not enabled in this environment, so there is no delivery data. Metrics only ever come from real provider events.</p>
            </div>
          ) : recipients.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No broadcasts sent in the last 30 days.</p>
          ) : (
            <ul className="flex flex-wrap gap-3 text-[12px]">
              {recipients.map(([status, count]) => (
                <li key={status} className="flex items-center gap-1.5"><EmBadge value={status} /> {count}</li>
              ))}
            </ul>
          )}
          {pairs(data?.activeSuppressions).length > 0 && (
            <p className="mt-2 text-[12px] text-muted-foreground">Active suppressions: {pairs(data?.activeSuppressions).map(([r, c]) => `${r.toLowerCase()} ${c}`).join(" · ")}</p>
          )}
        </PermissionBoundary>
      </EmCard>
      <EmCard title="Automations & worker" id="em-worker">
        <PermissionBoundary isLoading={q.isLoading} error={q.error} compact>
          <p className="text-[12px] text-muted-foreground">
            Automations: {pairs(data?.automations).map(([s, c]) => `${s.toLowerCase()} ${c}`).join(" · ") || "none"} · Enrollments: {pairs(data?.enrollments).map(([s, c]) => `${s.toLowerCase()} ${c}`).join(" · ") || "none"}
          </p>
          {data?.flags.emergencyStop && <p role="status" className="mt-1 text-[12px] font-semibold text-red-700">Emergency stop is active: nothing is sent; queued work is kept.</p>}
          {stuck.length > 0 ? (
            <ul className="mt-2 text-[12px] text-red-700" aria-label="Jobs needing attention">
              {stuck.map((j) => <li key={`${j.kind}-${j.status}`}>{j.kind.replace(/_/g, " ").toLowerCase()}: {j.count} {j.status.replace("_", " ").toLowerCase()}</li>)}
            </ul>
          ) : (
            <p className="mt-1 text-[12px] text-muted-foreground">No failed or dead-lettered marketing jobs.</p>
          )}
          {(data?.jobs ?? []).filter((j) => !["DEAD_LETTER", "FAILED"].includes(j.status)).map((j) => (
            <p key={`${j.kind}-${j.status}`} className="text-[11px] text-muted-foreground">{j.kind.replace(/_/g, " ").toLowerCase()} {j.status.toLowerCase()} {j.count}{j.oldestNextAttemptAt ? ` · next ${formatFullDate(j.oldestNextAttemptAt)}` : ""}</p>
          ))}
        </PermissionBoundary>
      </EmCard>
    </>
  );
}
