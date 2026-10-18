"use client";

import React, { useEffect, useState } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, TablePagination, ErrorBanner, formatDate } from "./table.utils";
import type { EnvConfigPayload } from "@/types/admin-ops.types";
import { Plus, Trash2, Pencil, Check, X, Eye, EyeOff } from "lucide-react";

const EMPTY_FORM: EnvConfigPayload = {
  key: "",
  value: "",
  description: "",
  isPublic: false,
  environment: "production",
};

function EnvBadge({ env }: { env: string }) {
  const styles: Record<string, string> = {
    production:  "bg-destructive/10 text-destructive",
    staging:     "bg-yellow-500/10 text-yellow-600",
    development: "bg-blue-500/10 text-blue-500",
  };
  return (
    <span className={`text-[11px] font-poppins font-semibold px-2 py-0.5 rounded-full capitalize ${styles[env] ?? "bg-muted text-muted-foreground"}`}>
      {env}
    </span>
  );
}

function MaskedValue({ value, isPublic }: { value: string | null; isPublic: boolean }) {
  const [revealed, setRevealed] = useState(false);
  if (!value) return <span className="text-[12px] font-poppins text-muted-foreground">—</span>;
  if (isPublic || revealed) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-[12px] font-poppins font-mono text-foreground max-w-[160px] truncate" title={value}>{value}</span>
        {!isPublic && (
          <button onClick={() => setRevealed(false)} className="text-muted-foreground hover:text-foreground transition-colors">
            <EyeOff className="w-3 h-3" />
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[12px] font-poppins font-mono text-muted-foreground">••••••••</span>
      <button onClick={() => setRevealed(true)} className="text-muted-foreground hover:text-foreground transition-colors">
        <Eye className="w-3 h-3" />
      </button>
    </span>
  );
}

function InlineEditRow({
  id,
  initialValue,
  initialDescription,
  onSave,
  onCancel,
  actionLoad,
}: {
  id: string;
  initialValue: string | null;
  initialDescription: string | null;
  onSave: (value: string, description: string) => void;
  onCancel: () => void;
  actionLoad: string | null;
}) {
  const [val, setVal] = useState(initialValue ?? "");
  const [desc, setDesc] = useState(initialDescription ?? "");
  
  return (
    <tr className="border-b border-border/50 bg-primary/[0.02]">
      {/* Key column - keep original value */}
      <td className="py-2 px-4 sm:px-5">
        <span className="text-[12px] font-poppins font-mono text-muted-foreground">
          (edit mode)
        </span>
      </td>
      
      {/* Environment column - keep original badge */}
      <td className="py-2 px-4 sm:px-5">
        {/* Empty or show original - doesn't matter */}
      </td>
      
      {/* Value column - editable */}
      <td className="py-2 px-4 sm:px-5">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="h-[30px] w-full min-w-[150px] px-2 bg-background border border-primary rounded-md text-[12px] font-poppins font-mono text-foreground outline-none"
          placeholder="Value"
          autoFocus
        />
      </td>
      
      {/* Description column - editable */}
      <td className="py-2 px-4 sm:px-5">
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          className="h-[30px] w-full min-w-[180px] px-2 bg-background border border-border rounded-md text-[12px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
          placeholder="Description"
        />
      </td>
      
      {/* Visibility column - show status */}
      <td className="py-2 px-4 sm:px-5">
        {/* Empty - visibility doesn't change during edit */}
      </td>
      
      {/* Updated column - empty */}
      <td className="py-2 px-4 sm:px-5">
        {/* Empty */}
      </td>
      
      {/* Actions column - Save/Cancel buttons */}
      <td className="py-2 px-4 sm:px-5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSave(val, desc)}
            disabled={actionLoad === id}
            className="h-[28px] px-2.5 bg-green-500/10 text-green-600 text-[11px] font-poppins font-semibold rounded-lg hover:bg-green-500/20 transition-colors disabled:opacity-60 flex items-center gap-1 whitespace-nowrap"
          >
            <Check className="w-3 h-3" /> Save
          </button>
          <button
            onClick={onCancel}
            className="h-[28px] px-2.5 bg-muted border border-border text-[11px] font-poppins text-foreground rounded-lg hover:bg-muted/80 transition-colors flex items-center gap-1 whitespace-nowrap"
          >
            <X className="w-3 h-3" /> Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function EnvConfigsTable() {
  const envConfigs      = useAdminOpsStore((s) => s.envConfigs);
  const pagination      = useAdminOpsStore((s) => s.envConfigPagination);
  const filters         = useAdminOpsStore((s) => s.envConfigFilters);
  const isLoading       = useAdminOpsStore((s) => s.isLoadingEnvConfigs);
  const actionLoad      = useAdminOpsStore((s) => s.actionLoading);
  const error           = useAdminOpsStore((s) => s.error);
  const fetch           = useAdminOpsStore((s) => s.fetchEnvConfigs);
  const setFilters      = useAdminOpsStore((s) => s.setEnvConfigFilters);
  const createConfig    = useAdminOpsStore((s) => s.createEnvConfig);
  const updateConfig    = useAdminOpsStore((s) => s.updateEnvConfig);
  const deleteConfig    = useAdminOpsStore((s) => s.deleteEnvConfig);
  const clearError      = useAdminOpsStore((s) => s.clearError);

  const [showForm, setShowForm]     = useState(false);
  const [form, setForm]             = useState<EnvConfigPayload>(EMPTY_FORM);
  const [editingId, setEditingId]   = useState<string | null>(null);

  useEffect(() => { fetch(); }, [filters.page]);

  const handleCreate = async () => {
    if (!form.key) return;
    await createConfig(form);
    setShowForm(false);
    setForm(EMPTY_FORM);
  };

  const handleSaveEdit = async (id: string, value: string, description: string) => {
    await updateConfig(id, { value, description });
    setEditingId(null);
  };

  const HEADERS = ["Key", "Environment", "Value", "Description", "Visibility", "Updated", "Actions"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">
            Environment Configs
            {pagination && (
              <span className="ml-2 text-[12px] font-normal text-muted-foreground">({pagination.totalItems} configs)</span>
            )}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">Runtime configuration per environment</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filters.status}
            onChange={(e) => { setFilters({ status: e.target.value, page: 1 }); fetch(); }}
            className="h-[36px] px-3 bg-muted border border-border rounded-lg text-[12px] font-poppins text-foreground outline-none"
          >
            <option value="">All Environments</option>
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="development">Development</option>
          </select>
          <button
            onClick={() => setShowForm(true)}
            className="h-[36px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg flex items-center gap-1.5 hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add Config
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      {/* Create Form */}
      {showForm && (
        <div className="mx-4 mb-4 p-4 bg-muted/40 border border-border rounded-xl grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 text-[13px] font-poppins font-semibold text-foreground">Add Environment Config</div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Key</label>
            <input
              value={form.key}
              onChange={(e) => setForm((p) => ({ ...p, key: e.target.value }))}
              placeholder="e.g. SMTP_HOST"
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins font-mono text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-poppins text-muted-foreground">Value</label>
            <input
              value={form.value ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, value: e.target.value }))}
              placeholder="Config value"
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins font-mono text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

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
            <label className="text-[11px] font-poppins text-muted-foreground">Description (optional)</label>
            <input
              value={form.description ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="What this config controls"
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

         {/* Create Form - Buttons section only */}
<div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
  <label className="flex items-center gap-2 cursor-pointer select-none order-2 sm:order-1">
    <input
      type="checkbox"
      checked={form.isPublic ?? false}
      onChange={(e) => setForm((p) => ({ ...p, isPublic: e.target.checked }))}
      className="w-4 h-4 accent-primary rounded"
    />
    <span className="text-[12px] font-poppins text-foreground">Public (visible without reveal)</span>
  </label>
  
  <div className="flex gap-3 order-1 sm:order-2">
    <button
      onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
      className="flex-1 sm:flex-none h-[34px] px-4 bg-muted border border-border text-[12px] font-poppins text-foreground rounded-lg hover:bg-muted/80 transition-colors"
    >
      Cancel
    </button>
    <button
      onClick={handleCreate}
      disabled={!form.key || actionLoad === "create"}
      className="flex-1 sm:flex-none h-[34px] px-5 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
    >
      {actionLoad === "create" ? "Saving..." : "Save Config"}
    </button>
  </div>
</div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px]">
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
  ) : envConfigs.length === 0 ? (
    <tr>
      <td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
        No environment configs found
      </td>
    </tr>
  ) : (
    envConfigs.map((row) => (
      <React.Fragment key={row.id}>
        <tr className="border-b border-border/50 hover:bg-muted/20 transition-colors">
          <td className="py-3 px-4 sm:px-5">
            <span className="text-[12px] font-poppins font-mono font-semibold text-foreground">{row.key}</span>
          </td>
          <td className="py-3 px-4 sm:px-5">
            <EnvBadge env={row.environment} />
          </td>
          <td className="py-3 px-4 sm:px-5">
            <MaskedValue value={row.value} isPublic={row.isPublic} />
          </td>
          <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground max-w-[200px] truncate" title={row.description ?? ""}>
            {row.description ?? "—"}
          </td>
          <td className="py-3 px-4 sm:px-5">
            <span className={`text-[11px] font-poppins font-semibold px-2 py-0.5 rounded-full ${
              row.isPublic
                ? "bg-green-500/10 text-green-600"
                : "bg-muted text-muted-foreground"
            }`}>
              {row.isPublic ? "Public" : "Private"}
            </span>
          </td>
          <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">
            {formatDate(row.updatedAt)}
          </td>
          <td className="py-3 px-4 sm:px-5">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setEditingId(editingId === row.id ? null : row.id)}
                disabled={actionLoad === row.id}
                title="Edit config"
                className="h-[28px] px-2.5 bg-primary/10 text-primary text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/20 transition-colors disabled:opacity-60 flex items-center gap-1"
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
              <button
                onClick={() => deleteConfig(row.id)}
                disabled={actionLoad === row.id}
                title="Delete config"
                className="h-[28px] px-2.5 bg-destructive/10 text-destructive text-[11px] font-poppins font-semibold rounded-lg hover:bg-destructive/20 transition-colors disabled:opacity-60 flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </td>
        </tr>
        {editingId === row.id && (
          <InlineEditRow
            id={row.id}
            initialValue={row.value}
            initialDescription={row.description}
            onSave={(value, description) => handleSaveEdit(row.id, value, description)}
            onCancel={() => setEditingId(null)}
            actionLoad={actionLoad}
          />
        )}
      </React.Fragment>
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