"use client";

// Product integration admin: the PIC registry (every Product Admin
// registration in this environment) and, per registration, the onboarding
// lifecycle, monitoring, datasets, subscriptions, operations and contracts.
// Product-neutral. Every admin route needs a recent MFA (gateway rule), so the
// whole section sits inside one MfaStepUpProvider. PIC authorizes every action
// against the staff member's PLATFORM grants; refusals are shown as reported.

import { useState } from "react";
import { MfaStepUpProvider } from "@/components/products/MfaStepUp";
import ProductDataState, { RefreshButton } from "@/components/products/ProductDataState";
import { integrationKeys, useAdminMutation, useIntegrationMonitorings, useIntegrations } from "@/lib/product-integrations.queries";
import * as svc from "@/lib/product-integrations.service";
import type { IntegrationRegistration, IntegrationRequestInput } from "@/lib/product-integrations.service";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ActionButton, Field, RefusalProvider, ServerError, StatusPill, SuccessNote, inputClass, useRefusal, when } from "./admin-ui";
import IntegrationDetail from "./IntegrationDetail";
import { ENVIRONMENTS } from "./lifecycle";
import ScopeEditor, { scopeFromText, type ScopeText } from "./ScopeEditor";

export default function ProductIntegrationsAdmin() {
  return (
    <MfaStepUpProvider description="Product integration administration needs a recent confirmation. Enter the 6-digit code from your authenticator app.">
      <RefusalProvider>
        <IntegrationsSection />
      </RefusalProvider>
    </MfaStepUpProvider>
  );
}

function IntegrationsSection() {
  const [selected, setSelected] = useState<string | null>(null);
  if (selected) return <IntegrationDetail id={selected} onBack={() => setSelected(null)} />;
  return <Registry onOpen={setSelected} />;
}

const th = "px-3 py-2 text-left font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
const td = "px-3 py-2 align-top font-poppins text-[12px] text-foreground";

function Registry({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useIntegrations();
  const rows = list.data ?? [];
  const monitorings = useIntegrationMonitorings(rows.map((r) => r.id), { enabled: rows.length > 0 });
  const { reasonFor } = useRefusal();
  const [registering, setRegistering] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const refused = reasonFor("integration.request");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title mb-1 text-foreground">Product integrations</h1>
          <p className="font-poppins text-[13px] text-muted-foreground">Registered Product Admins, their onboarding status, contract and synchronization health.</p>
        </div>
        {list.data && (
          <div className="flex items-center gap-2">
            <ActionButton
              label="Register product"
              variant="primary"
              disabledReason={refused ? `Not permitted (${refused}): you do not hold integration.request.` : null}
              onClick={() => {
                setSuccess(null);
                setRegistering(true);
              }}
            />
            <RefreshButton onClick={() => void list.refetch()} busy={list.isFetching} label="Reload integrations" />
          </div>
        )}
      </div>
      <SuccessNote message={success} />
      <ProductDataState
        title="Product integrations"
        loading={list.isPending}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={!!list.data && rows.length === 0}
        emptyMessage="No Product Admin is registered in this environment."
      >
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[860px]">
            <caption className="sr-only">Product integration registry</caption>
            <thead>
              <tr className="border-b border-border">
                <th className={th}>Product</th>
                <th className={th}>Environment</th>
                <th className={th}>Lifecycle</th>
                <th className={th}>Contract</th>
                <th className={th}>Health</th>
                <th className={th}>Sync</th>
                <th className={th}>Drift</th>
                <th className={th}>Operations</th>
                <th className={th}><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <RegistryRow key={r.id} row={r} monitoring={monitorings[i]} onOpen={() => onOpen(r.id)} />
              ))}
            </tbody>
          </table>
        </div>
      </ProductDataState>
      {registering && (
        <RegisterDialog
          onClose={() => setRegistering(false)}
          onRegistered={(reg) => {
            setRegistering(false);
            setSuccess(`${reg.display_name} registered as ${reg.lifecycle_status}. Next: verify identity.`);
          }}
        />
      )}
    </div>
  );
}

function RegistryRow({ row, monitoring, onOpen }: { row: IntegrationRegistration; monitoring: { data?: svc.IntegrationMonitoring; error: unknown; isPending: boolean } | undefined; onOpen: () => void }) {
  const m = monitoring?.data;
  const contract = monitoring?.isPending
    ? "Loading…"
    : m
      ? m.contract
        ? `rev ${m.contract.revision} (${m.contract.status})`
        : "None in force"
      : monitoring?.error
        ? `Unavailable (${svc.toAdminApiError(monitoring.error).reason ?? svc.toAdminApiError(monitoring.error).code})`
        : row.current_contract_id
          ? "In force"
          : "None in force";
  return (
    <tr className="border-b border-border/50">
      <td className={td}>
        <span className="font-semibold">{row.display_name}</span>
        <span className="block font-mono text-[10px] text-muted-foreground">{row.product_id}</span>
      </td>
      <td className={td}>{row.environment}</td>
      <td className={td}><StatusPill value={row.lifecycle_status} /><span className="block text-[10px] text-muted-foreground">rev {row.revision}</span></td>
      <td className={td}>{contract}{row.manifest_revision ? <span className="block text-[10px] text-muted-foreground">manifest rev {row.manifest_revision}</span> : null}</td>
      <td className={td}><StatusPill value={row.health_status} /><span className="block text-[10px] text-muted-foreground">{when(row.health_checked_at)}</span></td>
      <td className={td}><StatusPill value={m?.sync.status ?? row.sync_status} /></td>
      <td className={td}><StatusPill value={row.drift_status} /></td>
      <td className={td}>{row.operations_enabled ? "On" : "Off"}</td>
      <td className={td}>
        <button type="button" onClick={onOpen} aria-label={`Open ${row.display_name}`} className="rounded-lg border border-border px-3 py-1 font-poppins text-[12px] font-semibold text-foreground hover:bg-muted">
          Open
        </button>
      </td>
    </tr>
  );
}

// ── Registration request ──────────────────────────────────────────

type RegForm = Omit<IntegrationRequestInput, "allowed_scope" | "identity_fingerprint_ref"> & { identity_fingerprint_ref: string };

const FIELDS: { key: keyof RegForm; label: string; pattern?: RegExp; hint: string; placeholder?: string }[] = [
  { key: "product_id", label: "Product id", pattern: svc.PATTERNS.productId, hint: "Lower case, e.g. cfmeet", placeholder: "cfmeet" },
  { key: "display_name", label: "Display name", hint: "1-64 characters", placeholder: "CF Meet" },
  { key: "service_instance_id", label: "Service instance id", pattern: svc.PATTERNS.serviceInstanceId, hint: "Unique per deployment", placeholder: "cfmeet-admin-staging-1" },
  { key: "endpoint_ref", label: "Endpoint reference", pattern: svc.PATTERNS.endpointRef, hint: "An entry of PIC's endpoint allowlist", placeholder: "cfmeet-staging" },
  { key: "workload_identity", label: "Workload identity", pattern: svc.PATTERNS.workloadIdentity, hint: "spiffe:// or cf:// identity", placeholder: "cf://staging/cfmeet-admin" },
  { key: "approved_signer_kid", label: "Manifest signer key id", pattern: svc.PATTERNS.keyId, hint: "Enrolled in PIC's trusted signers", placeholder: "cfmeet-staging-2026-11" },
  { key: "identity_fingerprint_ref", label: "Identity fingerprint (optional)", pattern: svc.PATTERNS.fingerprint, hint: "sha256:<64 hex>, when the endpoint pins a certificate" },
];

function RegisterDialog({ onClose, onRegistered }: { onClose: () => void; onRegistered: (reg: IntegrationRegistration) => void }) {
  const { record } = useRefusal();
  const [form, setForm] = useState<RegForm>({ product_id: "", display_name: "", service_instance_id: "", environment: "staging", endpoint_ref: "", workload_identity: "", approved_signer_kid: "", identity_fingerprint_ref: "" });
  const [scopeText, setScopeText] = useState<ScopeText>({});
  const mutation = useAdminMutation<IntegrationRegistration, IntegrationRequestInput>("request", (input) => svc.requestIntegration(input), {
    invalidate: () => [integrationKeys.list()],
    onSuccess: (reg) => onRegistered(reg),
    onError: (e) => record("integration.request", e),
  });
  const problem = (f: (typeof FIELDS)[number]) => {
    const v = form[f.key].trim();
    if (!v) return f.key === "identity_fingerprint_ref" ? null : "Required";
    if (f.key === "display_name") return v.length <= 64 ? null : "At most 64 characters";
    return f.pattern && !f.pattern.test(v) ? "Not in the accepted format" : null;
  };
  const scope = scopeFromText(scopeText, { required: ["market", "organization"] });
  const ready = FIELDS.every((f) => problem(f) === null) && !scope.error;

  return (
    <Dialog open onOpenChange={(next) => !next && !mutation.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogTitle className="font-poppins text-[15px]">Register product</DialogTitle>
        <DialogDescription className="font-mono text-[11px] text-muted-foreground">POST /api/admin/product-integrations · DRAFT → REQUESTED (untrusted until every gate passes)</DialogDescription>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || mutation.isPending) return;
            mutation.mutate({
              product_id: form.product_id.trim(),
              display_name: form.display_name.trim(),
              service_instance_id: form.service_instance_id.trim(),
              environment: form.environment,
              endpoint_ref: form.endpoint_ref.trim(),
              workload_identity: form.workload_identity.trim(),
              approved_signer_kid: form.approved_signer_kid.trim(),
              ...(form.identity_fingerprint_ref.trim() && { identity_fingerprint_ref: form.identity_fingerprint_ref.trim() }),
              allowed_scope: scope.scope,
            });
          }}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <Field key={f.key} id={`reg-${f.key}`} label={f.label} hint={f.hint} error={form[f.key] ? problem(f) : null}>
                <input id={`reg-${f.key}`} className={inputClass} value={form[f.key]} placeholder={f.placeholder} autoComplete="off" onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))} />
              </Field>
            ))}
            <Field id="reg-environment" label="Environment" hint="Must match the environment PIC serves">
              <select id="reg-environment" className={inputClass} value={form.environment} onChange={(e) => setForm((prev) => ({ ...prev, environment: e.target.value }))}>
                {ENVIRONMENTS.map((env) => (
                  <option key={env} value={env}>{env}</option>
                ))}
              </select>
            </Field>
          </div>
          <ScopeEditor idPrefix="reg" value={scopeText} onChange={setScopeText} required={["market", "organization"]} error={scopeText.market || scopeText.organization ? scope.error : null} />
          <p className="font-poppins text-[11px] text-muted-foreground">Requires integration.request and a recent MFA. PIC checks the endpoint allowlist and the enrolled signer.</p>
          <ServerError error={mutation.error} />
          <div className="flex justify-end gap-2">
            <button type="button" disabled={mutation.isPending} onClick={onClose} className="h-9 rounded-lg px-4 font-poppins text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={!ready || mutation.isPending} className="h-9 rounded-lg bg-primary px-4 font-poppins text-[13px] font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60">
              {mutation.isPending ? "Working…" : "Submit registration"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
