"use client";

// Create one subscription: an approved dataset version, a department the
// dataset authorizes, and an exact scope within the dataset's dimensions and
// the product's allowed scope. PIC checks all of it again.

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { registrationKeys, useAdminMutation } from "@/lib/product-integrations.queries";
import * as svc from "@/lib/product-integrations.service";
import type { IntegrationDetail, ScopeDimension, SubscriptionCreateInput } from "@/lib/product-integrations.service";
import { Field, ServerError, inputClass } from "./admin-ui";
import ScopeEditor, { scopeFromText, type ScopeText } from "./ScopeEditor";

const optionalInt = (text: string, min: number, max: number): { value: number | undefined; error: string | null } => {
  if (!text.trim()) return { value: undefined, error: null };
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) return { value: undefined, error: `Whole number from ${min} to ${max}` };
  return { value: n, error: null };
};

export default function SubscriptionCreateDialog({
  detail,
  onClose,
  onCreated,
  onRefused,
}: {
  detail: IntegrationDetail;
  onClose: () => void;
  onCreated: (subscriptionId: string) => void;
  onRefused: (error: unknown) => void;
}) {
  const reg = detail.registration;
  const datasets = detail.datasets.filter((d) => d.approval_status === "APPROVED" && d.privacy_class !== "RESTRICTED_PII");
  const [datasetRow, setDatasetRow] = useState(datasets[0]?.id ?? "");
  const dataset = datasets.find((d) => d.id === datasetRow) ?? null;
  const [department, setDepartment] = useState(dataset?.authorized_departments[0] ?? "");
  const [scopeText, setScopeText] = useState<ScopeText>({});
  const [freshness, setFreshness] = useState("");
  const [poll, setPoll] = useState("");
  const [pageLimit, setPageLimit] = useState("");
  const [enabled, setEnabled] = useState(false);

  const mutation = useAdminMutation<{ subscription_id: string }, SubscriptionCreateInput>("subscription-create", (input) => svc.createSubscription(reg.id, input), {
    invalidate: () => registrationKeys(reg.id),
    onSuccess: (r) => onCreated(r.subscription_id),
    onError: (e) => onRefused(e),
  });

  const dims = (dataset?.scope_dimensions ?? []) as ScopeDimension[];
  const required = (["market", "organization"] as ScopeDimension[]).filter((d) => dims.includes(d));
  const scope = scopeFromText(scopeText, { dimensions: dims, required, allowed: reg.allowed_scope });
  const f = optionalInt(freshness, 1, 86_400 * 7);
  const p = optionalInt(poll, 1, 86_400);
  const l = optionalInt(pageLimit, 1, 1000);
  const ready = !!dataset && !!department && dataset.authorized_departments.includes(department) && !scope.error && !f.error && !p.error && !l.error;

  const submit = () => {
    if (!ready || !dataset || mutation.isPending) return;
    mutation.mutate({
      dataset_id: dataset.dataset_id,
      version: dataset.version,
      consumer_department: department,
      allowed_scope: scope.scope,
      ...(f.value !== undefined && { freshness_target_seconds: f.value }),
      ...(p.value !== undefined && { poll_interval_seconds: p.value }),
      ...(l.value !== undefined && { page_limit: l.value }),
      enabled,
    });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !mutation.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogTitle className="font-poppins text-[15px]">Create subscription</DialogTitle>
        <DialogDescription className="font-mono text-[11px] text-muted-foreground">POST /api/admin/product-integrations/{reg.id}/subscriptions</DialogDescription>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field id="sub-dataset" label="Approved dataset">
            <select
              id="sub-dataset"
              className={inputClass}
              value={datasetRow}
              onChange={(e) => {
                setDatasetRow(e.target.value);
                const next = datasets.find((d) => d.id === e.target.value);
                setDepartment(next?.authorized_departments[0] ?? "");
                setScopeText({});
              }}
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.dataset_id} {d.version} ({d.privacy_class})
                </option>
              ))}
            </select>
          </Field>
          <Field id="sub-department" label="Consumer department" hint="Only departments the dataset authorizes">
            <select id="sub-department" className={inputClass} value={department} onChange={(e) => setDepartment(e.target.value)}>
              {(dataset?.authorized_departments ?? []).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </Field>
          {dims.length > 0 ? (
            <ScopeEditor idPrefix="sub" value={scopeText} onChange={setScopeText} dimensions={dims} required={required} allowed={reg.allowed_scope} error={scope.error} />
          ) : (
            <p className="font-poppins text-[11px] text-muted-foreground">This dataset has no scope dimensions.</p>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field id="sub-freshness" label="Freshness target (s)" hint="Blank: dataset default" error={f.error}>
              <input id="sub-freshness" className={inputClass} inputMode="numeric" value={freshness} onChange={(e) => setFreshness(e.target.value)} />
            </Field>
            <Field id="sub-poll" label="Poll interval (s)" hint="Blank: 60" error={p.error}>
              <input id="sub-poll" className={inputClass} inputMode="numeric" value={poll} onChange={(e) => setPoll(e.target.value)} />
            </Field>
            <Field id="sub-page" label="Page limit" hint="Blank: 100" error={l.error}>
              <input id="sub-page" className={inputClass} inputMode="numeric" value={pageLimit} onChange={(e) => setPageLimit(e.target.value)} />
            </Field>
          </div>
          <label className="flex items-center gap-2 font-poppins text-[12px] text-foreground">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enable synchronization now
          </label>
          <p className="font-poppins text-[11px] text-muted-foreground">Requires integration.subscriptions.manage and a recent MFA. Refused while contract drift is unresolved.</p>
          <ServerError error={mutation.error} />
          <div className="flex justify-end gap-2">
            <button type="button" disabled={mutation.isPending} onClick={onClose} className="h-9 rounded-lg px-4 font-poppins text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={!ready || mutation.isPending} className="h-9 rounded-lg bg-primary px-4 font-poppins text-[13px] font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60">
              {mutation.isPending ? "Working…" : "Create subscription"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
