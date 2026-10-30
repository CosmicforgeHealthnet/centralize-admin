"use client";

import { useEffect, useState } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, TablePagination, ErrorBanner, formatDate } from "./table.utils";
import { Plus, CheckCircle } from "lucide-react";
import type { IncidentPayload, IncidentSeverity } from "@/types/admin-ops.types";

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#F64545", high: "#E8830A", medium: "#E8B600", low: "#3B82F6",
};

const STATUS_COLOR: Record<string, string> = {
  open: "#F64545", investigating: "#E8830A", identified: "#E8B600",
  monitoring: "#3B82F6", resolved: "#0DA53F", closed: "#8F90A4",
};

const EMPTY_FORM: IncidentPayload = { title: "", description: "", severity: "medium", affectedServices: [] };

export default function IncidentsTable() {
  const incidents   = useAdminOpsStore((s) => s.incidents);
  const pagination  = useAdminOpsStore((s) => s.incidentPagination);
  const filters     = useAdminOpsStore((s) => s.incidentFilters);
  const isLoading   = useAdminOpsStore((s) => s.isLoadingIncidents);
  const actionLoad  = useAdminOpsStore((s) => s.actionLoading);
  const error       = useAdminOpsStore((s) => s.error);
  const fetch       = useAdminOpsStore((s) => s.fetchIncidents);
  const setFilters  = useAdminOpsStore((s) => s.setIncidentFilters);
  const create      = useAdminOpsStore((s) => s.createIncident);
  const resolve     = useAdminOpsStore((s) => s.resolveIncident);
  const clearError  = useAdminOpsStore((s) => s.clearError);

  const [showForm, setShowForm]     = useState(false);
  const [form, setForm]             = useState<IncidentPayload>(EMPTY_FORM);
  const [servicesInput, setServicesInput] = useState("");

  useEffect(() => { fetch(); }, [filters.page, filters.status]);

  const handleCreate = async () => {
    if (!form.title || !form.severity) return;
    await create({ ...form, affectedServices: servicesInput.split(",").map((s) => s.trim()).filter(Boolean) });
    setShowForm(false);
    setForm(EMPTY_FORM);
    setServicesInput("");
  };

  const HEADERS = ["Title", "Severity", "Status", "Affected Services", "Created", "Resolved", "Actions"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">
            Incidents
            {pagination && <span className="ml-2 text-[12px] font-normal text-muted-foreground">({pagination.totalItems} incidents)</span>}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">System incidents and outage tracking</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filters.status}
            onChange={(e) => { setFilters({ status: e.target.value, page: 1 }); fetch(); }}
            className="h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
          >
            <option value="">All Status</option>
            <option value="open">Open</option>
            <option value="investigating">Investigating</option>
            <option value="identified">Identified</option>
            <option value="monitoring">Monitoring</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <button
            onClick={() => setShowForm(true)}
            className="h-[36px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg flex items-center gap-1.5 hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> New
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      {showForm && (
        <div className="mx-4 mb-4 p-4 bg-muted/40 border border-border rounded-xl grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 text-[13px] font-poppins font-semibold text-foreground">Report New Incident</div>
          <div className="sm:col-span-2 flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Title</label>
            <input
              value={form.title}
              onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. Payment service degraded"
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>
          <div className="sm:col-span-2 flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Description</label>
            <textarea
              value={form.description ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="Describe the incident..."
              rows={2}
              className="px-3 py-2 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors resize-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Severity</label>
            <select
              value={form.severity}
              onChange={(e) => setForm((p) => ({ ...p, severity: e.target.value as IncidentSeverity }))}
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Affected Services (comma-separated)</label>
            <input
              value={servicesInput}
              onChange={(e) => setServicesInput(e.target.value)}
              placeholder="e.g. payments, auth"
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>
          <div className="sm:col-span-2 flex items-center justify-end gap-2 pt-1">
            <button onClick={() => setShowForm(false)} className="h-[34px] px-4 bg-muted border border-border text-[12px] font-poppins text-foreground rounded-lg hover:bg-muted/80 transition-colors">Cancel</button>
            <button
              onClick={handleCreate}
              disabled={!form.title || actionLoad === "create"}
              className="h-[34px] px-5 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {actionLoad === "create" ? "Creating..." : "Create Incident"}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead>
            <tr className="border-b border-border">
              {HEADERS.map((h) => (
                <th key={h} className="text-left py-2.5 px-4 sm:px-5 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={HEADERS.length} />)
            ) : incidents.length === 0 ? (
              <tr><td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">No incidents reported</td></tr>
            ) : (
              incidents.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5">
                    <div className="text-[13px] font-poppins font-semibold text-foreground">{row.title}</div>
                    {row.description && <div className="text-[11px] font-poppins text-muted-foreground mt-0.5 max-w-[220px] truncate">{row.description}</div>}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <span className="text-[12px] font-poppins font-semibold capitalize" style={{ color: SEVERITY_COLOR[row.severity] ?? "#8F90A4" }}>
                      {row.severity}
                    </span>
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <span className="text-[12px] font-poppins font-semibold capitalize" style={{ color: STATUS_COLOR[row.status] ?? "#8F90A4" }}>
                      {row.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <div className="flex flex-wrap gap-1 max-w-[180px]">
                      {(row.affectedServices ?? []).map((s) => (
                        <span key={s} className="text-[10px] font-poppins px-1.5 py-0.5 bg-muted rounded text-muted-foreground">{s}</span>
                      ))}
                      {(row.affectedServices ?? []).length === 0 && <span className="text-[12px] font-poppins text-muted-foreground">—</span>}
                    </div>
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{formatDate(row.createdAt)}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">
                    {row.resolvedAt ? formatDate(row.resolvedAt) : "—"}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    {row.status !== "resolved" && row.status !== "closed" && (
                      <button
                        onClick={() => resolve(row.id)}
                        disabled={actionLoad === row.id}
                        className="h-[28px] px-2.5 bg-primary/10 text-primary text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/20 transition-colors disabled:opacity-60 flex items-center gap-1"
                      >
                        <CheckCircle className="w-3 h-3" /> Resolve
                      </button>
                    )}
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