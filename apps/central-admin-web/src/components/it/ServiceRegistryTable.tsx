"use client";

import { useEffect, useState } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, StatusBadge, TablePagination, ErrorBanner, formatDate, truncateId } from "./table.utils";
import type { RegisterServicePayload } from "@/types/admin-ops.types";
import { Plus, RefreshCw, Trash2, Wifi } from "lucide-react";

const STATUS_COLOR: Record<string, string> = {
  up: "#0DA53F", down: "#F64545", degraded: "#E8B600", unknown: "#8F90A4",
};

function StatusDot({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "#8F90A4";
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {status === "up" && <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ backgroundColor: color }} />}
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
      </span>
      <span className="text-[12px] font-poppins capitalize" style={{ color }}>{status}</span>
    </span>
  );
}

const EMPTY_FORM: RegisterServicePayload = { name: "", displayName: "", baseUrl: "", healthEndpoint: "", version: "", tags: [] };

export default function ServiceRegistryTable() {
  const services    = useAdminOpsStore((s) => s.services);
  const pagination  = useAdminOpsStore((s) => s.servicePagination);
  const filters     = useAdminOpsStore((s) => s.serviceFilters);
  const isLoading   = useAdminOpsStore((s) => s.isLoadingServices);
  const actionLoad  = useAdminOpsStore((s) => s.actionLoading);
  const error       = useAdminOpsStore((s) => s.error);
  const fetch       = useAdminOpsStore((s) => s.fetchServices);
  const setFilters  = useAdminOpsStore((s) => s.setServiceFilters);
  const ping        = useAdminOpsStore((s) => s.pingService);
  const register    = useAdminOpsStore((s) => s.registerService);
  const deregister  = useAdminOpsStore((s) => s.deregisterService);
  const clearError  = useAdminOpsStore((s) => s.clearError);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<RegisterServicePayload>(EMPTY_FORM);

  useEffect(() => { fetch(); }, [filters.page, filters.status]);

  const handleRegister = async () => {
    if (!form.name || !form.displayName) return;
    await register({ ...form, tags: form.tags?.filter(Boolean) });
    setShowForm(false);
    setForm(EMPTY_FORM);
  };

  const HEADERS = ["Service", "Status", "Version", "Base URL", "Last Checked", "Response", "Actions"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">
            Service Registry
            {pagination && <span className="ml-2 text-[12px] font-normal text-muted-foreground">({pagination.totalItems} services)</span>}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">Registered internal & external services</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filters.status}
            onChange={(e) => { setFilters({ status: e.target.value, page: 1 }); fetch(); }}
            className="h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
          >
            <option value="">All Status</option>
            <option value="up">Up</option>
            <option value="down">Down</option>
            <option value="degraded">Degraded</option>
            <option value="unknown">Unknown</option>
          </select>
          <button
            onClick={() => setShowForm(true)}
            className="h-[36px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg flex items-center gap-1.5 hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Register
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      {/* Register Form */}
      {showForm && (
        <div className="mx-4 mb-4 p-4 bg-muted/40 border border-border rounded-xl grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 text-[13px] font-poppins font-semibold text-foreground">Register New Service</div>
          {[
            { key: "name", label: "Name (unique key)", placeholder: "e.g. telemedicine-service" },
            { key: "displayName", label: "Display Name", placeholder: "e.g. Telemedicine Service" },
            { key: "baseUrl", label: "Base URL", placeholder: "https://api.example.com" },
            { key: "healthEndpoint", label: "Health Endpoint", placeholder: "https://api.example.com/health" },
            { key: "version", label: "Version", placeholder: "1.0.0" },
          ].map(({ key, label, placeholder }) => (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-[11px] font-poppins text-muted-foreground">{label}</label>
              <input
                value={String(form[key as keyof typeof form] ?? "")}
                onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
                placeholder={placeholder}
                className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
              />
            </div>
          ))}
          <div className="sm:col-span-2 flex items-center justify-end gap-2 pt-1">
            <button onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }} className="h-[34px] px-4 bg-muted border border-border text-[12px] font-poppins text-foreground rounded-lg hover:bg-muted/80 transition-colors">Cancel</button>
            <button
              onClick={handleRegister}
              disabled={!form.name || !form.displayName || actionLoad === "create"}
              className="h-[34px] px-5 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {actionLoad === "create" ? "Registering..." : "Register"}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px]">
          <thead>
            <tr className="border-b border-border">
              {HEADERS.map((h) => (
                <th key={h} className="text-left py-2.5 px-4 sm:px-5 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={HEADERS.length} />)
            ) : services.length === 0 ? (
              <tr><td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">No services registered</td></tr>
            ) : (
              services.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5">
                    <div className="text-[13px] font-poppins font-semibold text-foreground">{row.displayName}</div>
                    <div className="text-[11px] font-poppins text-muted-foreground font-mono mt-0.5">{row.name}</div>
                  </td>
                  <td className="py-3 px-4 sm:px-5"><StatusDot status={row.status} /></td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">{row.version ?? "—"}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground font-mono max-w-[180px] truncate">{row.baseUrl ?? "—"}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{row.lastCheckedAt ? formatDate(row.lastCheckedAt) : "Never"}</td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">{row.responseTimeMs != null ? `${row.responseTimeMs}ms` : "—"}</td>
                  <td className="py-3 px-4 sm:px-5">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => ping(row.id)}
                        disabled={actionLoad === row.id}
                        title="Ping health endpoint"
                        className="h-[28px] px-2.5 bg-primary/10 text-primary text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/20 transition-colors disabled:opacity-60 flex items-center gap-1"
                      >
                        <Wifi className="w-3 h-3" /> Ping
                      </button>
                      <button
                        onClick={() => deregister(row.id)}
                        disabled={actionLoad === row.id}
                        title="Deregister service"
                        className="h-[28px] px-2.5 bg-destructive/10 text-destructive text-[11px] font-poppins font-semibold rounded-lg hover:bg-destructive/20 transition-colors disabled:opacity-60 flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <TablePagination currentPage={pagination?.currentPage ?? 1} totalPages={pagination?.totalPages ?? 1} onPageChange={(p) => { setFilters({ page: p }); fetch(); }} />
    </div>
  );
}