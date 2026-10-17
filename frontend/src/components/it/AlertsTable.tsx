"use client";

import { useEffect, useState } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, TablePagination, ErrorBanner, formatDate } from "./table.utils";
import type { AlertPayload } from "@/types/admin-ops.types";
import { Plus, CheckCircle2, Eye, Bell } from "lucide-react";

const SEVERITY_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  critical: { bg: "bg-destructive/10", text: "text-destructive",     dot: "#F64545" },
  warning:  { bg: "bg-yellow-500/10",  text: "text-yellow-600",      dot: "#E8B600" },
  info:     { bg: "bg-blue-500/10",    text: "text-blue-500",        dot: "#3B82F6" },
};

const TYPE_LABELS: Record<string, string> = {
  job_failure:     "Job Failure",
  health_degraded: "Health Degraded",
  dead_letter:     "Dead Letter",
  webhook_failure: "Webhook Failure",
  custom:          "Custom",
};

const EMPTY_FORM: AlertPayload = {
  type: "custom",
  severity: "info",
  message: "",
  source: "",
};

function SeverityBadge({ severity }: { severity: string }) {
  const s = SEVERITY_STYLES[severity] ?? { bg: "bg-muted", text: "text-muted-foreground", dot: "#8F90A4" };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-poppins font-semibold ${s.bg} ${s.text}`}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
      {severity.charAt(0).toUpperCase() + severity.slice(1)}
    </span>
  );
}

export default function AlertsTable() {
  const alerts        = useAdminOpsStore((s) => s.alerts);
  const pagination    = useAdminOpsStore((s) => s.alertPagination);
  const filters       = useAdminOpsStore((s) => s.alertFilters);
  const isLoading     = useAdminOpsStore((s) => s.isLoadingAlerts);
  const actionLoad    = useAdminOpsStore((s) => s.actionLoading);
  const error         = useAdminOpsStore((s) => s.error);
  const unreadCount   = useAdminOpsStore((s) => s.unreadAlertCount);
  const fetch         = useAdminOpsStore((s) => s.fetchAlerts);
  const setFilters    = useAdminOpsStore((s) => s.setAlertFilters);
  const createAlert   = useAdminOpsStore((s) => s.createAlert);
  const markRead      = useAdminOpsStore((s) => s.markAlertRead);
  const resolveAlert  = useAdminOpsStore((s) => s.resolveAlert);
  const clearError    = useAdminOpsStore((s) => s.clearError);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<AlertPayload>(EMPTY_FORM);

  useEffect(() => { fetch(); }, [filters.page, filters.status]);

  const handleCreate = async () => {
    if (!form.message) return;
    await createAlert(form);
    setShowForm(false);
    setForm(EMPTY_FORM);
  };

  const HEADERS = ["Type", "Severity", "Message", "Source", "Status", "Created", "Actions"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground flex items-center gap-2">
            System Alerts
            {unreadCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-destructive text-white text-[10px] font-poppins font-bold">
                {unreadCount}
              </span>
            )}
            {pagination && (
              <span className="text-[12px] font-normal text-muted-foreground">({pagination.totalItems} alerts)</span>
            )}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">System-generated and custom alerts</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filters.status}
            onChange={(e) => { setFilters({ status: e.target.value, page: 1 }); fetch(); }}
            className="h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
          </select>
          <button
            onClick={() => setShowForm(true)}
            className="h-[36px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg flex items-center gap-1.5 hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Create
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      {/* Create Form */}
      {showForm && (
        <div className="mx-4 mb-4 p-4 bg-muted/40 border border-border rounded-xl grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 text-[13px] font-poppins font-semibold text-foreground">Create Alert</div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Type</label>
            <select
              value={form.type}
              onChange={(e) => setForm((p) => ({ ...p, type: e.target.value as AlertPayload["type"] }))}
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            >
              {Object.entries(TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Severity</label>
            <select
              value={form.severity}
              onChange={(e) => setForm((p) => ({ ...p, severity: e.target.value as AlertPayload["severity"] }))}
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          <div className="sm:col-span-2 flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Message</label>
            <input
              value={form.message}
              onChange={(e) => setForm((p) => ({ ...p, message: e.target.value }))}
              placeholder="Alert message..."
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Source (optional)</label>
            <input
              value={form.source ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, source: e.target.value }))}
              placeholder="e.g. job-scheduler"
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          <div className="sm:col-span-2 flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
              className="h-[34px] px-4 bg-muted border border-border text-[12px] font-poppins text-foreground rounded-lg hover:bg-muted/80 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!form.message || actionLoad === "create"}
              className="h-[34px] px-5 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {actionLoad === "create" ? "Creating..." : "Create Alert"}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px]">
          <thead>
            <tr className="border-b border-border">
              {HEADERS.map((h) => (
                <th key={h} className="text-left py-2.5 px-4 sm:px-5 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={HEADERS.length} />)
            ) : alerts.length === 0 ? (
              <tr>
                <td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  No alerts found
                </td>
              </tr>
            ) : (
              alerts.map((row) => (
                <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${!row.isRead ? "bg-primary/[0.02]" : ""}`}>
                  <td className="py-3 px-4 sm:px-5">
                    <span className="text-[12px] font-poppins text-foreground">
                      {TYPE_LABELS[row.type] ?? row.type}
                    </span>
                    {!row.isRead && (
                      <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-primary align-middle" title="Unread" />
                    )}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <SeverityBadge severity={row.severity} />
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-foreground max-w-[240px] truncate" title={row.message}>
                    {row.message}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">
                    {row.source ?? "—"}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <span className={`text-[11px] font-poppins font-semibold px-2 py-0.5 rounded-full ${
                      row.isResolved
                        ? "bg-green-500/10 text-green-600"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {row.isResolved ? "Resolved" : "Active"}
                    </span>
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">
                    {formatDate(row.createdAt)}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <div className="flex items-center gap-2">
                      {!row.isRead && (
                        <button
                          onClick={() => markRead(row.id)}
                          disabled={actionLoad === row.id}
                          title="Mark as read"
                          className="h-[28px] px-2.5 bg-primary/10 text-primary text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/20 transition-colors disabled:opacity-60 flex items-center gap-1"
                        >
                          <Eye className="w-3 h-3" /> Read
                        </button>
                      )}
                      {!row.isResolved && (
                        <button
                          onClick={() => resolveAlert(row.id)}
                          disabled={actionLoad === row.id}
                          title="Resolve alert"
                          className="h-[28px] px-2.5 bg-green-500/10 text-green-600 text-[11px] font-poppins font-semibold rounded-lg hover:bg-green-500/20 transition-colors disabled:opacity-60 flex items-center gap-1"
                        >
                          <CheckCircle2 className="w-3 h-3" /> Resolve
                        </button>
                      )}
                      {row.isResolved && row.isRead && (
                        <span className="text-[11px] font-poppins text-muted-foreground">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <TablePagination
        currentPage={pagination?.currentPage ?? 1}
        totalPages={pagination?.totalPages ?? 1}
        onPageChange={(p) => { setFilters({ page: p }); fetch(); }}
      />
    </div>
  );
}