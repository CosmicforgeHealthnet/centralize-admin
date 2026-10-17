"use client";

import { useEffect, useState } from "react";
import { useAdminOpsStore } from "@/stores/admin-ops.store";
import { SkeletonRow, TablePagination, ErrorBanner, formatDate } from "./table.utils";
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
import type { WebhookPayload } from "@/types/admin-ops.types";

const EMPTY_FORM: WebhookPayload = { name: "", url: "", events: [], isActive: true, provider: "", description: "" };

export default function WebhooksTable() {
  const webhooks    = useAdminOpsStore((s) => s.webhooks);
  const pagination  = useAdminOpsStore((s) => s.webhookPagination);
  const filters     = useAdminOpsStore((s) => s.webhookFilters);
  const isLoading   = useAdminOpsStore((s) => s.isLoadingWebhooks);
  const actionLoad  = useAdminOpsStore((s) => s.actionLoading);
  const error       = useAdminOpsStore((s) => s.error);
  const fetch       = useAdminOpsStore((s) => s.fetchWebhooks);
  const setFilters  = useAdminOpsStore((s) => s.setWebhookFilters);
  const create      = useAdminOpsStore((s) => s.createWebhook);
  const update      = useAdminOpsStore((s) => s.updateWebhook);
  const del         = useAdminOpsStore((s) => s.deleteWebhook);
  const clearError  = useAdminOpsStore((s) => s.clearError);

  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState<string | null>(null);
  const [form, setForm]         = useState<WebhookPayload>(EMPTY_FORM);
  const [eventsInput, setEventsInput] = useState("");

  useEffect(() => { fetch(); }, [filters.page]);

  const openCreate = () => { setEditId(null); setForm(EMPTY_FORM); setEventsInput(""); setShowForm(true); };
  const openEdit   = (id: string) => {
    const w = webhooks.find((x) => x.id === id);
    if (!w) return;
    setEditId(id);
    setForm({ name: w.name, url: w.url, events: w.events ?? [], isActive: w.isActive, provider: w.provider ?? "", description: w.description ?? "" });
    setEventsInput((w.events ?? []).join(", "));
    setShowForm(true);
  };

  const handleSubmit = async () => {
    const payload = { ...form, events: eventsInput.split(",").map((e) => e.trim()).filter(Boolean) };
    if (editId) { await update(editId, payload); }
    else { await create(payload); }
    setShowForm(false);
  };

  const HEADERS = ["Name", "URL", "Events", "Provider", "Active", "Created", "Actions"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-poppins font-semibold text-foreground">
            Webhooks
            {pagination && <span className="ml-2 text-[12px] font-normal text-muted-foreground">({pagination.totalItems} endpoints)</span>}
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">Outbound webhook endpoints & configurations</p>
        </div>
        <button
          onClick={openCreate}
          className="h-[36px] px-4 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg flex items-center gap-1.5 hover:bg-primary/90 transition-colors self-start"
        >
          <Plus className="w-3.5 h-3.5" /> Add Webhook
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      {showForm && (
        <div className="mx-4 mb-4 p-4 bg-muted/40 border border-border rounded-xl grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 text-[13px] font-poppins font-semibold text-foreground">{editId ? "Edit Webhook" : "New Webhook"}</div>
          {[
            { key: "name", label: "Name", placeholder: "e.g. payment-events" },
            { key: "url", label: "URL", placeholder: "https://example.com/webhook" },
            { key: "provider", label: "Provider", placeholder: "e.g. stripe" },
            { key: "description", label: "Description", placeholder: "What this webhook does" },
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
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="text-[11px] font-poppins text-muted-foreground">Events (comma-separated)</label>
            <input
              value={eventsInput}
              onChange={(e) => setEventsInput(e.target.value)}
              placeholder="e.g. payment.success, user.created"
              className="h-[36px] px-3 bg-background border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="isActive" checked={form.isActive ?? true} onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))} className="w-4 h-4 accent-primary" />
            <label htmlFor="isActive" className="text-[12px] font-poppins text-foreground">Active</label>
          </div>
          <div className="sm:col-span-2 flex items-center justify-end gap-2 pt-1">
            <button onClick={() => setShowForm(false)} className="h-[34px] px-4 bg-muted border border-border text-[12px] font-poppins text-foreground rounded-lg hover:bg-muted/80 transition-colors">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={!form.name || !form.url || actionLoad === "create" || actionLoad === editId}
              className="h-[34px] px-5 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {actionLoad ? "Saving..." : editId ? "Update" : "Create"}
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
            ) : webhooks.length === 0 ? (
              <tr><td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">No webhooks configured</td></tr>
            ) : (
              webhooks.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 sm:px-5">
                    <div className="text-[13px] font-poppins font-semibold text-foreground">{row.name}</div>
                    {row.description && <div className="text-[11px] font-poppins text-muted-foreground mt-0.5">{row.description}</div>}
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground font-mono max-w-[200px] truncate">{row.url}</td>
                  <td className="py-3 px-4 sm:px-5">
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {(row.events ?? []).slice(0, 3).map((e) => (
                        <span key={e} className="text-[10px] font-poppins px-1.5 py-0.5 bg-muted rounded text-muted-foreground">{e}</span>
                      ))}
                      {(row.events ?? []).length > 3 && <span className="text-[10px] font-poppins text-muted-foreground">+{(row.events ?? []).length - 3}</span>}
                    </div>
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground capitalize">{row.provider ?? "—"}</td>
                  <td className="py-3 px-4 sm:px-5">
                    {row.isActive
                      ? <ToggleRight className="w-5 h-5 text-primary" />
                      : <ToggleLeft className="w-5 h-5 text-muted-foreground" />
                    }
                  </td>
                  <td className="py-3 px-4 sm:px-5 text-[12px] font-poppins text-muted-foreground whitespace-nowrap">{formatDate(row.createdAt)}</td>
                  <td className="py-3 px-4 sm:px-5">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openEdit(row.id)}
                        disabled={!!actionLoad}
                        className="h-[28px] px-2.5 bg-muted text-foreground text-[11px] font-poppins font-semibold rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-60 flex items-center gap-1"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => del(row.id)}
                        disabled={actionLoad === row.id}
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