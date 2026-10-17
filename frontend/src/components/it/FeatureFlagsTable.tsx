"use client";

import { useEffect, useState } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, TablePagination, ErrorBanner, formatDate } from "./table.utils";
import type { FeatureFlagPayload } from "@/types/admin-ops.types";
import { Plus, Trash2, ToggleLeft, ToggleRight } from "lucide-react";

const EMPTY_FORM: FeatureFlagPayload = {
  key: "",
  name: "",
  description: "",
  isEnabled: false,
  environment: "production",
  rolloutPercentage: undefined,
};

export default function FeatureFlagsTable() {
  const flags       = useAdminOpsStore((s) => s.flags);
  const pagination  = useAdminOpsStore((s) => s.flagPagination);
  const filters     = useAdminOpsStore((s) => s.flagFilters);
  const isLoading   = useAdminOpsStore((s) => s.isLoadingFlags);
  const actionLoad  = useAdminOpsStore((s) => s.actionLoading);
  const error       = useAdminOpsStore((s) => s.error);
  const fetch       = useAdminOpsStore((s) => s.fetchFlags);
  const setFilters  = useAdminOpsStore((s) => s.setFlagFilters);
  const createFlag  = useAdminOpsStore((s) => s.createFlag);
  const deleteFlag  = useAdminOpsStore((s) => s.deleteFlag);
  const toggleFlag  = useAdminOpsStore((s) => s.toggleFlag);
  const clearError  = useAdminOpsStore((s) => s.clearError);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<FeatureFlagPayload>(EMPTY_FORM);

  useEffect(() => { fetch(); }, [filters.page]);

  const handleCreate = async () => {
    if (!form.key || !form.name) return;
    await createFlag(form);
    setShowForm(false);
    setForm(EMPTY_FORM);
  };

  const HEADERS = ["Flag", "Environment", "Status", "Rollout", "Created By", "Last Updated", "Actions"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">
            Feature Flags
            {pagination && (
              <span className="ml-2 text-[12px] font-normal text-muted-foreground">({pagination.totalItems} flags)</span>
            )}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">Manage feature rollouts across environments</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowForm(true)}
            className="h-[36px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg flex items-center gap-1.5 hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> New Flag
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      {/* Create Form */}
      {showForm && (
        <div className="mx-4 mb-4 p-4 bg-muted/40 border border-border rounded-xl grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 text-[13px] font-poppins font-semibold text-foreground">Create Feature Flag</div>

          {[
            { key: "key",  label: "Key (unique)",  placeholder: "e.g. enable-new-checkout" },
            { key: "name", label: "Display Name",  placeholder: "e.g. New Checkout Flow" },
          ].map(({ key, label, placeholder }) => (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-[11px] font-poppins text-muted-foreground">{label}</label>
              <input
                value={form[key as keyof typeof form] ?? ""}
                onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
                placeholder={placeholder}
                className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
              />
            </div>
          ))}

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Environment</label>
            <select
              value={form.environment ?? "production"}
              onChange={(e) => setForm((p) => ({ ...p, environment: e.target.value }))}
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            >
              <option value="production">Production</option>
              <option value="staging">Staging</option>
              <option value="development">Development</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Rollout % (optional)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={form.rolloutPercentage ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, rolloutPercentage: e.target.value ? Number(e.target.value) : undefined }))}
              placeholder="0–100"
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          <div className="sm:col-span-2 flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Description (optional)</label>
            <input
              value={form.description ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="Brief description of what this flag controls"
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          <div className="sm:col-span-2 flex items-center gap-3 pt-1">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.isEnabled ?? false}
                onChange={(e) => setForm((p) => ({ ...p, isEnabled: e.target.checked }))}
                className="w-4 h-4 accent-primary rounded"
              />
              <span className="text-[12px] font-poppins text-foreground">Enable immediately</span>
            </label>
            <div className="flex-1" />
            <button
              onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
              className="h-[34px] px-4 bg-muted border border-border text-[12px] font-poppins text-foreground rounded-lg hover:bg-muted/80 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!form.key || !form.name || actionLoad === "create"}
              className="h-[34px] px-5 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {actionLoad === "create" ? "Creating..." : "Create Flag"}
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
            ) : flags.length === 0 ? (
              <tr>
                <td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  No feature flags found
                </td>
              </tr>
            ) : (
              flags.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5">
                    <div className="text-[13px] font-poppins font-semibold text-foreground">{row.name}</div>
                    <div className="text-[11px] font-poppins font-mono text-muted-foreground mt-0.5">{row.key}</div>
                    {row.description && (
                      <div className="text-[11px] font-poppins text-muted-foreground mt-0.5 max-w-[200px] truncate" title={row.description}>
                        {row.description}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <span className="text-[11px] font-poppins font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground capitalize">
                      {row.environment}
                    </span>
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <span className={`text-[11px] font-poppins font-semibold px-2.5 py-0.5 rounded-full ${
                      row.isEnabled
                        ? "bg-green-500/10 text-green-600"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {row.isEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">
                    {row.rolloutPercentage != null ? (
                      <div className="flex items-center gap-2">
                        <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full transition-all"
                            style={{ width: `${row.rolloutPercentage}%` }}
                          />
                        </div>
                        <span>{row.rolloutPercentage}%</span>
                      </div>
                    ) : "—"}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground">
                    {row.createdBy ?? "—"}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">
                    {formatDate(row.updatedAt)}
                  </td>
                  <td className="py-3 px-4 sm:px-5">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleFlag(row.key, !row.isEnabled)}
                        disabled={actionLoad === row.key}
                        title={row.isEnabled ? "Disable flag" : "Enable flag"}
                        className={`h-[28px] px-2.5 text-[11px] font-poppins font-semibold rounded-lg transition-colors disabled:opacity-60 flex items-center gap-1 ${
                          row.isEnabled
                            ? "bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20"
                            : "bg-green-500/10 text-green-600 hover:bg-green-500/20"
                        }`}
                      >
                        {row.isEnabled
                          ? <><ToggleLeft className="w-3 h-3" /> Disable</>
                          : <><ToggleRight className="w-3 h-3" /> Enable</>
                        }
                      </button>
                      <button
                        onClick={() => deleteFlag(row.key)}
                        disabled={actionLoad === row.key}
                        title="Delete flag"
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

      <TablePagination
        currentPage={pagination?.currentPage ?? 1}
        totalPages={pagination?.totalPages ?? 1}
        onPageChange={(p) => { setFilters({ page: p }); fetch(); }}
      />
    </div>
  );
}