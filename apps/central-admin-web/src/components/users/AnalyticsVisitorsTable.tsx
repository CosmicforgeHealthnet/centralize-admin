"use client";

import { useEffect, useState } from "react";
import { useUsersStore } from "@/stores/users.store";
import { Monitor, Smartphone, Globe, CheckCircle2, XCircle, ChevronLeft, ChevronRight } from "lucide-react";

export default function AnalyticsVisitorsTable() {
  const visitors   = useUsersStore((s) => s.analyticsVisitors);
  const pagination = useUsersStore((s) => s.analyticsVisitorsPagination);
  const isLoading  = useUsersStore((s) => s.isLoadingAnalyticsVisitors);
  const fetch      = useUsersStore((s) => s.fetchAnalyticsVisitors);

  const [page, setPage]   = useState(1);
  const [intent, setIntent] = useState("");
  const [converted, setConverted] = useState<string>("");

  useEffect(() => {
    fetch({
      page,
      limit: 20,
      user_type_intent: intent || undefined,
      converted: converted !== "" ? converted === "true" : undefined,
    });
  }, [page, intent, converted]);

  const totalPages = pagination ? Math.ceil(pagination.total / pagination.limit) : 1;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-[16px] font-poppins font-semibold text-foreground">Visitor Sessions</h2>
          <p className="text-[12px] font-poppins text-muted-foreground">
            {pagination?.total.toLocaleString() ?? 0} total sessions
          </p>
        </div>

        {/* Filters */}
        <div className="flex gap-2 flex-wrap">
          <select
            value={intent}
            onChange={(e) => { setIntent(e.target.value); setPage(1); }}
            className="text-[12px] font-poppins bg-card border border-border rounded-[8px] px-3 py-1.5 text-foreground focus:outline-none focus:border-primary"
          >
            <option value="">All Intent</option>
            <option value="doctor">Doctor</option>
            <option value="patient">Patient</option>
            <option value="pharmacy">Pharmacy</option>
            <option value="lab">Lab</option>
            <option value="unknown">Unknown</option>
          </select>

          <select
            value={converted}
            onChange={(e) => { setConverted(e.target.value); setPage(1); }}
            className="text-[12px] font-poppins bg-card border border-border rounded-[8px] px-3 py-1.5 text-foreground focus:outline-none focus:border-primary"
          >
            <option value="">All</option>
            <option value="true">Converted</option>
            <option value="false">Not Converted</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {["Session", "First Seen", "Last Seen", "Intent", "Country", "Device", "Pages", "Events", "Converted"].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-poppins font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border animate-pulse">
                    {Array.from({ length: 9 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-muted rounded-full w-20" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : visitors.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-[13px] font-poppins text-muted-foreground">
                    No visitor sessions found
                  </td>
                </tr>
              ) : (
                visitors.map((v) => (
                  <tr key={v.session_id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-[12px] font-poppins text-foreground font-mono">
                      {v.session_id.slice(0, 12)}…
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">
                      {new Date(v.first_seen).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">
                      {new Date(v.last_seen).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[11px] font-poppins px-2 py-0.5 rounded-full bg-primary/10 text-primary capitalize">
                        {v.user_type_intent}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">
                      {v.geo_country ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {v.device_type === "mobile" ? (
                        <Smartphone className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <Monitor className="w-4 h-4 text-muted-foreground" />
                      )}
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">
                      {Array.isArray(v.pages_visited) ? v.pages_visited.length : 0}
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">
                      {v.events_count}
                    </td>
                    <td className="px-4 py-3">
                      {v.converted ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : (
                        <XCircle className="w-4 h-4 text-muted-foreground" />
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-[12px] font-poppins text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-[8px] border border-border disabled:opacity-40 hover:bg-muted transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded-[8px] border border-border disabled:opacity-40 hover:bg-muted transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}