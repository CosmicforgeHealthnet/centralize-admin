"use client";

import { useEffect } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import ProviderBadge, { BadgeProvider } from "../../shared/ProviderBadge";
import StatusChip from "../../shared/StatusChip";
import DataTable, { DataTableColumn } from "../../shared/DataTable";
import PermissionGate from "../../shared/PermissionGate";
import type { SOJob } from "@/types/social-operations.types";

export default function OperationsMonitorPage() {
  const permissions = useSocialPermissions();
  const { jobs, isLoadingJobs, fetchJobs, retryJob, cancelJob, actionLoading, error } = useSocialOperationsStore();

  useEffect(() => {
    fetchJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: DataTableColumn<SOJob>[] = [
    { key: "type", header: "Type", render: (j) => <span className="font-poppins text-[11px] text-foreground">{j.type}</span> },
    { key: "provider", header: "Provider", render: (j) => <ProviderBadge provider={j.provider as BadgeProvider} size="sm" /> },
    { key: "status", header: "Status", render: (j) => <StatusChip status={j.status} /> },
    { key: "attempts", header: "Attempts", render: (j) => j.attempts },
    { key: "next", header: "Next attempt", render: (j) => (j.nextAttemptAt ? new Date(j.nextAttemptAt).toLocaleString() : "—") },
    { key: "error", header: "Error", render: (j) => (
        <span className="font-poppins text-[11px] text-red-500">{j.error?.replace(/_/g, " ") ?? "—"}</span>
      ) },
    { key: "actions", header: "Actions", render: (j) => {
        const isActing = actionLoading === j.id;
        const canRetry = j.status === "FAILED" || j.status === "RETRY_SCHEDULED";
        const canCancel = j.status === "PENDING" || j.status === "RETRY_SCHEDULED";
        return (
          <div className="flex items-center gap-2">
            {canRetry && (
              <PermissionGate hasPermission={permissions.social_operations === "EDIT"}>
                <button onClick={() => retryJob(j.id)} disabled={isActing} className="font-poppins text-[11px] font-medium text-primary disabled:opacity-40">
                  Retry
                </button>
              </PermissionGate>
            )}
            {canCancel && (
              <PermissionGate hasPermission={permissions.social_operations === "EDIT"}>
                <button onClick={() => cancelJob(j.id)} disabled={isActing} className="font-poppins text-[11px] text-muted-foreground disabled:opacity-40">
                  Cancel
                </button>
              </PermissionGate>
            )}
          </div>
        );
      } },
  ];

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins mb-3">{error}</div>}
      <DataTable columns={columns} rows={jobs} rowKey={(j) => j.id} isLoading={isLoadingJobs} emptyLabel="No publishing or action jobs running" />
    </div>
  );
}