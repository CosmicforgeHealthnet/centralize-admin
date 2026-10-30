"use client";

import { useEffect, useState } from "react";
import { useUsersStore } from "@/stores/users.store";
import { ChevronLeft, ChevronRight } from "lucide-react";

const roleColors: Record<string, string> = {
  doctor:   "#272EA7",
  patient:  "#0DA53F",
  pharmacy: "#E8B600",
  lab:      "#8F90A4",
};

export default function AnalyticsWaitlistTable() {
  const entries    = useUsersStore((s) => s.analyticsWaitlist);
  const pagination = useUsersStore((s) => s.analyticsWaitlistPagination);
  const isLoading  = useUsersStore((s) => s.isLoadingAnalyticsWaitlist);
  const fetch      = useUsersStore((s) => s.fetchAnalyticsWaitlist);

  const [page, setPage] = useState(1);
  const [role, setRole] = useState("");

  useEffect(() => {
    fetch({ page, limit: 20, role: role || undefined });
  }, [page, role]);

  const totalPages = pagination ? Math.ceil(pagination.total / pagination.limit) : 1;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-[16px] font-poppins font-semibold text-foreground">Waitlist Signups</h2>
          <p className="text-[12px] font-poppins text-muted-foreground">
            {pagination?.total.toLocaleString() ?? 0} total signups
          </p>
        </div>

        <select
          value={role}
          onChange={(e) => { setRole(e.target.value); setPage(1); }}
          className="text-[12px] font-poppins bg-card border border-border rounded-[8px] px-3 py-1.5 text-foreground focus:outline-none focus:border-primary"
        >
          <option value="">All Roles</option>
          <option value="doctor">Doctor</option>
          <option value="patient">Patient</option>
          <option value="pharmacy">Pharmacy</option>
          <option value="lab">Lab</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {["Name", "Role", "Email", "Phone", "Country", "Facility", "Signed Up"].map((h) => (
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
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-muted rounded-full w-24" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-[13px] font-poppins text-muted-foreground">
                    No waitlist entries found
                  </td>
                </tr>
              ) : (
                entries.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-[13px] font-poppins font-medium text-foreground">
                      {e.full_name ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="text-[11px] font-poppins px-2 py-0.5 rounded-full capitalize"
                        style={{
                          backgroundColor: `${roleColors[e.role] ?? "#8F90A4"}18`,
                          color: roleColors[e.role] ?? "#8F90A4",
                        }}
                      >
                        {e.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">
                      {e.email ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">
                      {e.phone ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">
                      {e.country ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground">
                      {e.facility_name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">
                      {new Date(e.signed_up_at).toLocaleDateString()}
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