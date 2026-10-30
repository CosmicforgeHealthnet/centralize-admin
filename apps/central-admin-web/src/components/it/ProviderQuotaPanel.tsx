"use client";

// Final gap 3 (mail administrators): observed provider sending quota per
// provider account, and the approved pricing rows that cost estimates use.
// Used figures come only from provider response headers / quota errors;
// limits only from configuration; "remaining" only when both are known.
// Pricing changes need an MFA step-up (MAIL_PRICING_CHANGE). No billed spend
// exists: the provider has no billing API.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import PermissionBoundary from "@/components/mail/PermissionBoundary";
import StepUpDialog from "@/components/marketing/email-marketing/StepUpDialog";
import { formatFullDate } from "@/components/mail/mail-utils";
import { classifyMailError } from "@/lib/mail.service";
import type { ProviderQuotaSnapshot } from "@/types/mail-marketing.types";

const BASE = "/api/mail/v1/admin";
const unwrap = <T,>(response: { data: { data: T } }) => response.data.data;

export interface ProviderQuotaReport {
  generatedAt: string;
  items: ProviderQuotaSnapshot[];
  billing: { status: "UNAVAILABLE"; reason: string };
}
export interface ProviderPricingRow {
  id: string;
  provider: string;
  organizationId: string | null;
  currency: string;
  unitCostMicros: number;
  unitCost: string;
  includedMonthly: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: "CONTRACT" | "PRICE_LIST" | "INVOICE";
  reference: string;
  label: string;
}
interface PricingInput {
  provider: string;
  organizationId?: string;
  currency: string;
  unitCost: string;
  includedMonthly?: number;
  effectiveFrom: string;
  effectiveTo?: string;
  source: string;
  reference: string;
}

export const fetchProviderQuota = async () => unwrap<ProviderQuotaReport>(await api.get(`${BASE}/provider-quota`));
export const fetchPricing = async () => unwrap<{ items: ProviderPricingRow[]; label: string }>(await api.get(`${BASE}/pricing`));
export const createPricing = async (input: PricingInput & { stepUpId: string }) => unwrap<ProviderPricingRow>(await api.post(`${BASE}/pricing`, input));
export const endPricing = async (id: string, effectiveTo: string | null, stepUpId: string) => unwrap<ProviderPricingRow>(await api.patch(`${BASE}/pricing/${id}`, { effectiveTo, stepUpId }));

const card = "rounded-lg border border-border bg-card p-4";
const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-[12px] outline-none focus:border-primary";
const btn = "rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50";
const ghost = "rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50";

const value = (used: number | null | undefined, limit: number | null | undefined) => `${used ?? "unknown"} / ${limit ?? "limit unknown"}`;

function NotReady({ error, children }: { error: unknown; children: React.ReactNode }) {
  if (classifyMailError(error).code === "MAIL_FEATURE_NOT_READY") {
    return <p role="status" className="text-[12px] text-muted-foreground">Available after the latest Mail database update is applied.</p>;
  }
  return <>{children}</>;
}

function QuotaTable() {
  const q = useQuery({ queryKey: ["mail", "ops", "provider-quota"], queryFn: fetchProviderQuota, retry: false, refetchInterval: 60000 });
  return (
    <section className={card} aria-labelledby="ops-quota-h" data-testid="provider-quota-panel">
      <h2 id="ops-quota-h" className="mb-2 text-[13px] font-semibold">Provider sending quota</h2>
      <NotReady error={q.error}>
        <PermissionBoundary isLoading={q.isLoading} error={q.error} retry={() => q.refetch()} compact>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <caption className="sr-only">Observed provider quota per account</caption>
              <thead className="text-muted-foreground"><tr><th className="py-1">Account</th><th>Today (used / limit)</th><th>This month (used / limit)</th><th>Remaining</th><th>Observed</th></tr></thead>
              <tbody>
                {(q.data?.items ?? []).map((item) => (
                  <tr key={`${item.provider}:${item.scope}`} className="border-t border-border align-top">
                    <td className="py-1.5">
                      {item.scope === "account" ? "Company account" : item.scope}
                      <div className="text-muted-foreground">{item.provider}</div>
                      {item.exhausted && <div role="alert" className="font-semibold text-red-600">Quota exhausted ({item.exhaustedKind?.toLowerCase()}) until {formatFullDate(item.exhaustedUntil)}</div>}
                    </td>
                    <td>{value(item.dailyUsed, item.dailyLimit)}</td>
                    <td>{value(item.monthlyUsed, item.monthlyLimit)}</td>
                    <td>{item.remainingStatus === "KNOWN" ? `${item.remaining?.daily ?? "–"} today · ${item.remaining?.monthly ?? "–"} this month` : "Unknown"}</td>
                    <td>{item.status === "UNKNOWN" ? "Not observed yet" : formatFullDate(item.observedAt)}{item.source && <div className="text-muted-foreground">{item.source.replace(/_/g, " ").toLowerCase()}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Used figures are read from provider response headers (the daily figure is only sent on the free plan). Limits come from MAIL_PROVIDER_DAILY_LIMIT / MAIL_PROVIDER_MONTHLY_LIMIT; without them remaining quota is unknown. Quota resets at midnight UTC (daily) and on the 1st of the month (monthly); exhausted sends wait for the reset.
          </p>
          {q.data && <p className="text-[11px] text-muted-foreground">Billed spend: {q.data.billing.reason}</p>}
        </PermissionBoundary>
      </NotReady>
    </section>
  );
}

const emptyForm = { provider: "resend", organizationId: "", currency: "USD", unitCost: "", includedMonthly: "", effectiveFrom: "", source: "CONTRACT", reference: "" };

function Pricing() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["mail", "ops", "pricing"], queryFn: fetchPricing, retry: false });
  const [form, setForm] = useState(emptyForm);
  const [pending, setPending] = useState<{ kind: "create" } | { kind: "end"; row: ProviderPricingRow; effectiveTo: string } | null>(null);
  const [endAt, setEndAt] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const set = (field: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [field]: e.target.value }));
  const run = useMutation({
    mutationFn: async (stepUpId: string) => {
      if (!pending) return null;
      if (pending.kind === "create") {
        return createPricing({
          provider: form.provider.trim(),
          organizationId: form.organizationId.trim() || undefined,
          currency: form.currency.trim(),
          unitCost: form.unitCost.trim(),
          includedMonthly: form.includedMonthly.trim() ? Number(form.includedMonthly) : undefined,
          effectiveFrom: new Date(form.effectiveFrom).toISOString(),
          source: form.source,
          reference: form.reference.trim(),
          stepUpId,
        });
      }
      return endPricing(pending.row.id, new Date(pending.effectiveTo).toISOString(), stepUpId);
    },
    onSuccess: () => {
      setMsg({ text: pending?.kind === "create" ? "Pricing saved. Existing estimates are not changed." : "Pricing period updated. Existing estimates are not changed.", tone: "ok" });
      if (pending?.kind === "create") setForm(emptyForm);
      setPending(null);
      qc.invalidateQueries({ queryKey: ["mail", "ops", "pricing"] });
    },
    onError: (e) => {
      const info = classifyMailError(e);
      const field = typeof info.detail?.field === "string" ? ` (${info.detail.field}${info.detail.reason ? `: ${String(info.detail.reason).replace(/_/g, " ").toLowerCase()}` : ""})` : "";
      setMsg({ text: `${info.message}${field}`, tone: "error" });
      setPending(null);
    },
  });
  const validForm = /^\d+(\.\d{1,6})?$/.test(form.unitCost.trim()) && /^[A-Z]{3}$/.test(form.currency.trim()) && form.effectiveFrom && form.reference.trim();

  return (
    <section className={card} aria-labelledby="ops-pricing-h" data-testid="provider-pricing-panel">
      <h2 id="ops-pricing-h" className="mb-2 text-[13px] font-semibold">Approved provider pricing</h2>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Cost estimates multiply the recipients a provider accepted by the price effective when the broadcast was sent. They are estimates, not billed spend, and they do not change when pricing changes later.
      </p>
      <NotReady error={q.error}>
        <PermissionBoundary isLoading={q.isLoading} error={q.error} retry={() => q.refetch()} compact>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <caption className="sr-only">Approved pricing rows</caption>
              <thead className="text-muted-foreground"><tr><th className="py-1">Provider</th><th>Scope</th><th>Price per email</th><th>Effective</th><th>Source</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {(q.data?.items ?? []).length === 0 && <tr><td colSpan={6} className="py-2 text-muted-foreground">No pricing yet: campaign costs show as unavailable.</td></tr>}
                {(q.data?.items ?? []).map((row) => (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className="py-1.5">{row.provider}</td>
                    <td>{row.organizationId ? "Brand" : "Account"}</td>
                    <td>{row.currency} {row.unitCost}{row.includedMonthly != null && <div className="text-muted-foreground">{row.includedMonthly} included / month</div>}</td>
                    <td>{formatFullDate(row.effectiveFrom)} – {row.effectiveTo ? formatFullDate(row.effectiveTo) : "open"}</td>
                    <td>{row.source.replace(/_/g, " ").toLowerCase()}<div className="text-muted-foreground">{row.reference}</div></td>
                    <td className="text-right">
                      <div className="flex items-end justify-end gap-1">
                        <label className="sr-only" htmlFor={`end-${row.id}`}>End date for {row.reference}</label>
                        <input id={`end-${row.id}`} type="datetime-local" className={input} value={endAt[row.id] ?? ""} onChange={(e) => setEndAt((current) => ({ ...current, [row.id]: e.target.value }))} />
                        <button type="button" className={ghost} disabled={!endAt[row.id]} onClick={() => setPending({ kind: "end", row, effectiveTo: endAt[row.id] })}>End period</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4" aria-label="Add pricing" onSubmit={(e) => { e.preventDefault(); if (validForm) setPending({ kind: "create" }); }}>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">Provider<input className={input} value={form.provider} onChange={set("provider")} required /></label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">Brand id (optional)<input className={input} value={form.organizationId} onChange={set("organizationId")} placeholder="Whole account" /></label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">Currency<input className={input} value={form.currency} onChange={set("currency")} maxLength={3} required /></label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">Price per email<input className={input} value={form.unitCost} onChange={set("unitCost")} inputMode="decimal" placeholder="0.0009" required /></label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">Included per month (optional)<input className={input} value={form.includedMonthly} onChange={set("includedMonthly")} inputMode="numeric" /></label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">Effective from<input className={input} type="datetime-local" value={form.effectiveFrom} onChange={set("effectiveFrom")} required /></label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">Source
              <select className={input} value={form.source} onChange={set("source")}>
                <option value="CONTRACT">Contract</option><option value="PRICE_LIST">Price list</option><option value="INVOICE">Invoice</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">Reference<input className={input} value={form.reference} onChange={set("reference")} maxLength={200} required placeholder="Order form / invoice no." /></label>
            <div className="sm:col-span-4 flex items-center gap-2">
              <button type="submit" className={btn} disabled={!validForm || run.isPending}>Save pricing</button>
              {msg && <p role={msg.tone === "error" ? "alert" : "status"} className={`text-[11px] ${msg.tone === "error" ? "text-red-600" : "text-muted-foreground"}`}>{msg.text}</p>}
            </div>
          </form>
        </PermissionBoundary>
      </NotReady>
      {pending && (
        <StepUpDialog purpose="MAIL_PRICING_CHANGE" title={pending.kind === "create" ? "Approve provider pricing" : "Change pricing period"} onVerified={(stepUpId) => run.mutate(stepUpId)} onCancel={() => setPending(null)} />
      )}
    </section>
  );
}

export default function ProviderQuotaPanel() {
  return (
    <div className="flex flex-col gap-4">
      <QuotaTable />
      <Pricing />
    </div>
  );
}
