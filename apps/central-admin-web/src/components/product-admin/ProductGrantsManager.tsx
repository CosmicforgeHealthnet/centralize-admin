"use client";

// Product grants manager: per product, the staff grants PIC holds (paged),
// one grant's detail, creating a PRODUCT grant with an exact scope per
// dimension, and revoking a grant with a reason code. Reads and writes need
// integration.grants.manage and a recent MFA (gateway + PIC rules). The UI
// never offers wildcards and never grants or revokes for the signed-in user
// (PIC refuses self-grants and self-revocation).

import { useMemo, useState } from "react";
import { MfaStepUpProvider } from "@/components/products/MfaStepUp";
import ProductDataState, { RefreshButton } from "@/components/products/ProductDataState";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useProductGrant, useProductGrantsInfinite } from "@/lib/products.queries";
import { grantKeys, useAdminMutation, useIntegration, useIntegrations } from "@/lib/product-integrations.queries";
import * as svc from "@/lib/product-integrations.service";
import type { ProductGrantAction, ProductGrantCreateInput, ProductGrantCreateResult } from "@/lib/product-integrations.service";
import type { ProductGrant } from "@/types/products.types";
import { ActionButton, Card, ConfirmActionDialog, Field, KeyValue, RefusalProvider, ScopeList, ServerError, StatusPill, SuccessNote, inputClass, shortId, useRefusal, useStaffId, when } from "./admin-ui";
import { REASON_FIELD } from "./lifecycle";
import ScopeEditor, { scopeFromText, type ScopeText } from "./ScopeEditor";

/** PRODUCT actions in PIC's action catalog (packages/identity-and-permissions/src/actions.js). */
const PRODUCT_ACTIONS: { id: ProductGrantAction; note: string }[] = [
  { id: "product.view", note: "See the product in navigation" },
  { id: "product.manifest.read", note: "Read the approved contract" },
  { id: "product.capabilities.read", note: "Live capability states (recent MFA)" },
  { id: "dataset.list", note: "List approved datasets" },
  { id: "metric.read", note: "Metrics of the datasets listed below" },
  { id: "events.status.read", note: "Synchronization status" },
  { id: "operation.read", note: "Read operations and audit" },
  { id: "resource.read", note: "Scoped live reads (recent MFA)" },
  { id: "report.read", note: "Scoped reports (recent MFA)" },
  { id: "operation.submit", note: "Submit governed commands (recent MFA, independent approval)" },
];

const PAGE_SIZE = 25;
const PERMISSION = "integration.grants.manage";

export default function ProductGrantsManager() {
  return (
    <MfaStepUpProvider description="Viewing and changing staff product grants needs a recent confirmation. Enter the 6-digit code from your authenticator app.">
      <RefusalProvider>
        <GrantsSection />
      </RefusalProvider>
    </MfaStepUpProvider>
  );
}

function GrantsSection() {
  const registry = useIntegrations();
  const products = useMemo(() => Array.from(new Set((registry.data ?? []).filter((r) => r.lifecycle_status !== "REVOKED" && r.lifecycle_status !== "REJECTED").map((r) => r.product_id))).sort(), [registry.data]);
  const [productText, setProductText] = useState("");
  const [productId, setProductId] = useState<string | null>(null);
  const productError = productText && !svc.PATTERNS.productId.test(productText.trim()) ? "Lower-case product id, e.g. cfmeet" : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title mb-1 text-foreground">Product grants</h1>
        <p className="font-poppins text-[13px] text-muted-foreground">Staff access to one product: role, actions, datasets and exact scope. Requires integration.grants.manage and a recent MFA.</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const v = productText.trim();
          if (svc.PATTERNS.productId.test(v)) setProductId(v);
        }}
      >
        <div className="w-full max-w-[280px]">
          <Field id="grants-product" label="Product" hint="Enter the product id" error={productError}>
            <input id="grants-product" className={inputClass} value={productText} autoComplete="off" placeholder="cfmeet" onChange={(e) => setProductText(e.target.value)} />
          </Field>
        </div>
        <button type="submit" disabled={!productText.trim() || !!productError} className="mb-[18px] h-9 rounded-lg bg-primary px-4 font-poppins text-[13px] font-semibold text-white hover:bg-primary/90 disabled:opacity-60">
          Show grants
        </button>
        {products.length > 0 && (
          <div className="flex w-full flex-wrap items-center gap-1.5" aria-label="Registered products">
            <span className="font-poppins text-[11px] text-muted-foreground">Registered:</span>
            {products.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setProductText(p);
                  setProductId(p);
                }}
                aria-pressed={productId === p}
                className="rounded-full border border-border px-2.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted aria-pressed:border-primary aria-pressed:text-primary"
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </form>
      {productId && <ProductGrants key={productId} productId={productId} registrationId={(registry.data ?? []).find((r) => r.product_id === productId && r.lifecycle_status !== "REVOKED" && r.lifecycle_status !== "REJECTED")?.id ?? null} />}
    </div>
  );
}

const th = "px-3 py-2 text-left font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
const td = "px-3 py-2 align-top font-poppins text-[12px] text-foreground";

function validity(g: ProductGrant): string {
  const from = g.not_before ? `from ${when(g.not_before)}` : "";
  const to = g.expires_at ? `until ${when(g.expires_at)}` : "no expiry";
  return [from, to].filter(Boolean).join(" ");
}

function ProductGrants({ productId, registrationId }: { productId: string; registrationId: string | null }) {
  const [staffText, setStaffText] = useState("");
  const [staffFilter, setStaffFilter] = useState<string | undefined>(undefined);
  const grants = useProductGrantsInfinite(productId, { staff_id: staffFilter, limit: PAGE_SIZE });
  const items = (grants.data?.pages ?? []).flatMap((p) => p.grants);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const { reasonFor } = useRefusal();
  const refused = reasonFor(PERMISSION);
  const staffError = staffText && !svc.PATTERNS.staffId.test(staffText.trim()) ? "Not a valid staff id" : null;
  const roles = Array.from(new Set(items.map((g) => g.role).filter((r): r is string => !!r))).sort();

  return (
    <div className="flex flex-col gap-4">
      <SuccessNote message={success} />
      <Card
        title={`Grants for ${productId}`}
        description="Newest first. Only PRODUCT grants bound to this product are listed."
        actions={
          grants.data ? (
            <>
              <ActionButton
                label="Create grant"
                variant="primary"
                disabledReason={refused ? `Not permitted (${refused}): you do not hold ${PERMISSION}.` : null}
                onClick={() => {
                  setSuccess(null);
                  setCreating(true);
                }}
              />
              <RefreshButton onClick={() => void grants.refetch()} busy={grants.isFetching} label="Reload grants" />
            </>
          ) : null
        }
      >
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (staffError) return;
            setStaffFilter(staffText.trim() || undefined);
          }}
        >
          <div className="w-full max-w-[240px]">
            <Field id="grants-staff-filter" label="Filter by staff id" error={staffError}>
              <input id="grants-staff-filter" className={inputClass} value={staffText} autoComplete="off" onChange={(e) => setStaffText(e.target.value)} />
            </Field>
          </div>
          <button type="submit" disabled={!!staffError} className="h-9 rounded-lg border border-border px-3 font-poppins text-[12px] font-semibold text-foreground hover:bg-muted disabled:opacity-60">
            Apply
          </button>
        </form>
        <ProductDataState
          title="Product grants"
          loading={grants.isPending}
          error={grants.error}
          onRetry={() => grants.refetch()}
          empty={!!grants.data && items.length === 0}
          emptyMessage={staffFilter ? `No grants for ${staffFilter} on ${productId}.` : `No staff grants for ${productId}.`}
          embedded
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <caption className="sr-only">Product grants</caption>
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>Staff</th><th className={th}>Role</th><th className={th}>Effect</th><th className={th}>Actions</th><th className={th}>Scope</th><th className={th}>Validity</th><th className={th}>Status</th><th className={th}><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((g) => (
                  <tr key={g.grant_id} className="border-b border-border/50">
                    <td className={td}>{g.staff_id}</td>
                    <td className={td}>{g.role ?? "—"}</td>
                    <td className={td}><StatusPill value={g.effect} /></td>
                    <td className={td}><span className="font-mono text-[10px]">{g.actions.join(", ")}</span></td>
                    <td className={td}><ScopeList scope={g.scope} /></td>
                    <td className={td}>{validity(g)}</td>
                    <td className={td}><StatusPill value={g.status} /></td>
                    <td className={td}>
                      <button type="button" onClick={() => setSelected(g.grant_id)} aria-label={`Open grant ${shortId(g.grant_id)} for ${g.staff_id}`} className="rounded-lg border border-border px-3 py-1 font-poppins text-[12px] font-semibold hover:bg-muted">
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {grants.hasNextPage && (
            <button type="button" onClick={() => void grants.fetchNextPage()} disabled={grants.isFetchingNextPage} className="mt-2 h-8 self-start rounded-lg border border-border px-3 font-poppins text-[12px] font-semibold hover:bg-muted disabled:opacity-60">
              {grants.isFetchingNextPage ? "Loading…" : "Load more grants"}
            </button>
          )}
        </ProductDataState>
      </Card>
      {selected && <GrantDetail productId={productId} grantId={selected} onClose={() => setSelected(null)} onRevoked={(msg) => setSuccess(msg)} />}
      {creating && (
        <CreateGrantDialog
          productId={productId}
          registrationId={registrationId}
          roles={roles}
          onClose={() => setCreating(false)}
          onCreated={(id, staff) => {
            setCreating(false);
            setSuccess(`Grant ${shortId(id)} created for ${staff} on ${productId}.`);
          }}
        />
      )}
    </div>
  );
}

// ── Grant detail and revocation ───────────────────────────────────

function GrantDetail({ productId, grantId, onClose, onRevoked }: { productId: string; grantId: string; onClose: () => void; onRevoked: (message: string) => void }) {
  const q = useProductGrant(productId, grantId);
  const me = useStaffId();
  const { reasonFor, record } = useRefusal();
  const [confirming, setConfirming] = useState(false);
  const revoke = useAdminMutation<svc.ProductGrantRevokeResult, { reason_code: string }>("grant-revoke", (input) => svc.revokeProductGrant(grantId, input), {
    invalidate: () => grantKeys(productId),
    onSuccess: () => {
      setConfirming(false);
      onRevoked(`Grant ${shortId(grantId)} revoked.`);
    },
    onError: (e) => record(PERMISSION, e),
  });
  const g = q.data;
  const refused = reasonFor(PERMISSION);
  const revokeBlock = !g
    ? null
    : refused
      ? `Not permitted (${refused}): you do not hold ${PERMISSION}.`
      : g.revoked_at
        ? "Already revoked."
        : me && g.staff_id === me
          ? "You cannot revoke a grant that applies to yourself (SELF_REVOKE_DENIED)."
          : null;

  return (
    <Card
      title={`Grant ${shortId(grantId)}`}
      labelledBy="grant-detail-title"
      actions={
        <>
          {g && <ActionButton label="Revoke grant" variant="danger" disabledReason={revokeBlock} onClick={() => { revoke.reset(); setConfirming(true); }} />}
          <button type="button" onClick={onClose} className="h-8 rounded-lg px-3 font-poppins text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground">Close</button>
        </>
      }
    >
      <ProductDataState title="Grant" loading={q.isPending} error={q.error} onRetry={() => q.refetch()} embedded compact>
        {g && (
          <KeyValue
            items={[
              ["Grant id", <span key="id" className="font-mono text-[11px]">{g.grant_id}</span>],
              ["Status", <StatusPill key="st" value={g.status} />],
              ["Staff", g.staff_id],
              ["Role", g.role ?? "—"],
              ["Effect", <StatusPill key="ef" value={g.effect} />],
              ["Kind", g.grant_kind],
              ["Actions", <span key="a" className="font-mono text-[11px]">{g.actions.join(", ")}</span>],
              ["Datasets", g.datasets && g.datasets.length ? g.datasets.join(", ") : "None"],
              ["Scope", <ScopeList key="sc" scope={g.scope} />],
              ["Validity", validity(g)],
              ["Granted", `${when(g.created_at)}${g.granted_by ? ` by ${g.granted_by}` : ""}`],
              ["Revoked", g.revoked_at ? `${when(g.revoked_at)} by ${g.revoked_by ?? "?"} (${g.revocation_reason ?? "no reason"})` : "—"],
            ]}
          />
        )}
      </ProductDataState>
      {confirming && g && (
        <ConfirmActionDialog
          open
          onOpenChange={(next) => !next && setConfirming(false)}
          title="Confirm grant revoke"
          action={`POST /api/admin/product-integration-grants/${g.grant_id}/revoke · ${g.staff_id} on ${productId}`}
          description={`${g.staff_id} loses ${g.actions.join(", ")} on ${productId} immediately.`}
          requirements={["Permission integration.grants.manage and a recent MFA.", "A reason code.", "Nobody revokes a grant that applies to themselves."]}
          fields={[REASON_FIELD]}
          confirmLabel="Revoke grant"
          danger
          busy={revoke.isPending}
          error={revoke.error}
          onConfirm={(values) => revoke.mutate({ reason_code: values.reason_code })}
        />
      )}
    </Card>
  );
}

// ── Create grant ──────────────────────────────────────────────────

/** datetime-local value -> ISO string (or null when blank / invalid). */
function isoFromLocal(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function CreateGrantDialog({ productId, registrationId, roles, onClose, onCreated }: { productId: string; registrationId: string | null; roles: string[]; onClose: () => void; onCreated: (grantId: string, staffId: string) => void }) {
  const me = useStaffId();
  const { record } = useRefusal();
  // Registry detail (when readable) gives the product's allowed scope and approved datasets.
  const registration = useIntegration(registrationId);
  const allowed = registration.data?.registration.allowed_scope ?? null;
  const approvedDatasets = Array.from(new Set((registration.data?.datasets ?? []).filter((d) => d.approval_status === "APPROVED").map((d) => d.dataset_id))).sort();

  const [staff, setStaff] = useState("");
  const [role, setRole] = useState("");
  const [effect, setEffect] = useState<"ALLOW" | "DENY">("ALLOW");
  const [actions, setActions] = useState<ProductGrantAction[]>([]);
  const [datasetText, setDatasetText] = useState("");
  const [scopeText, setScopeText] = useState<ScopeText>({});
  const [notBefore, setNotBefore] = useState("");
  const [expires, setExpires] = useState("");

  const mutation = useAdminMutation<ProductGrantCreateResult, ProductGrantCreateInput>("grant-create", (input) => svc.createProductGrant(input), {
    invalidate: () => grantKeys(productId),
    onSuccess: (r, input) => onCreated(r.grant_id, input.staff_id),
    onError: (e) => record(PERMISSION, e),
  });

  const staffValue = staff.trim();
  const staffError = !staffValue ? null : !svc.PATTERNS.staffId.test(staffValue) ? "Not a valid staff id" : me && staffValue === me ? "You cannot grant access to yourself (SELF_GRANT_DENIED)." : null;
  const roleError = role.trim() && !svc.PATTERNS.role.test(role.trim()) ? "Lower case, e.g. cfmeet.viewer" : null;
  const datasets = datasetText.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
  const datasetError = datasets.find((d) => !svc.PATTERNS.datasetId.test(d))
    ? "A dataset id is not valid"
    : approvedDatasets.length && datasets.some((d) => !approvedDatasets.includes(d))
      ? "Only approved datasets of this product can be granted"
      : new Set(datasets).size !== datasets.length
        ? "A dataset is listed twice"
        : null;
  const required = effect === "ALLOW" ? (["market", "organization"] as const) : ([] as const);
  const scope = scopeFromText(scopeText, { required, allowed });
  const nb = isoFromLocal(notBefore);
  const ex = isoFromLocal(expires);
  const dateError = expires && !ex ? "Invalid expiry" : nb && ex && Date.parse(ex) <= Date.parse(nb) ? "The expiry must be after the start" : null;
  const actionError = actions.length === 0 ? "Choose at least one action" : actions.includes("metric.read") && datasets.length === 0 && effect === "ALLOW" ? "metric.read only works for the datasets listed" : null;
  const ready = !!staffValue && !staffError && !roleError && !datasetError && !scope.error && !dateError && actions.length > 0;

  return (
    <Dialog open onOpenChange={(next) => !next && !mutation.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="font-poppins text-[15px]">Create grant for {productId}</DialogTitle>
        <DialogDescription className="font-mono text-[11px] text-muted-foreground">POST /api/admin/product-integration-grants · grant_kind PRODUCT</DialogDescription>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || mutation.isPending) return;
            mutation.mutate({
              grant_kind: "PRODUCT",
              product_id: productId,
              staff_id: staffValue,
              ...(role.trim() && { role: role.trim() }),
              effect,
              actions,
              datasets,
              scope: scope.scope,
              ...(nb && { not_before: nb }),
              ...(ex && { expires_at: ex }),
            });
          }}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field id="grant-staff" label="Staff id" hint="The staff member's HQ id" error={staffError}>
              <input id="grant-staff" className={inputClass} value={staff} autoComplete="off" onChange={(e) => setStaff(e.target.value)} />
            </Field>
            <Field id="grant-role" label="Role (optional)" hint={roles.length ? `In use: ${roles.join(", ")}` : "e.g. cfmeet.viewer"} error={roleError}>
              <input id="grant-role" className={inputClass} value={role} autoComplete="off" onChange={(e) => setRole(e.target.value)} />
            </Field>
            <Field id="grant-effect" label="Effect" hint={effect === "DENY" ? "An explicit deny always wins" : "Allows the chosen actions"}>
              <select id="grant-effect" className={inputClass} value={effect} onChange={(e) => setEffect(e.target.value as "ALLOW" | "DENY")}>
                <option value="ALLOW">ALLOW</option>
                <option value="DENY">DENY</option>
              </select>
            </Field>
          </div>
          <fieldset className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <legend className="px-1 font-poppins text-[12px] font-semibold text-foreground">Actions</legend>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {PRODUCT_ACTIONS.map((a) => (
                <label key={a.id} className="flex items-start gap-2 font-poppins text-[12px] text-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={actions.includes(a.id)}
                    onChange={(e) => setActions((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id)))}
                  />
                  <span>
                    <span className="font-mono text-[11px]">{a.id}</span>
                    <span className="block text-[10px] text-muted-foreground">{a.note}</span>
                  </span>
                </label>
              ))}
            </div>
            {actions.length > 0 && actionError && <p className="font-poppins text-[11px] text-amber-600">{actionError}</p>}
          </fieldset>
          <Field
            id="grant-datasets"
            label="Datasets (optional)"
            hint={approvedDatasets.length ? `Approved: ${approvedDatasets.join(", ")}` : "Comma separated dataset ids; must be approved for this product"}
            error={datasetError}
          >
            <input id="grant-datasets" className={inputClass} value={datasetText} autoComplete="off" onChange={(e) => setDatasetText(e.target.value)} />
          </Field>
          <ScopeEditor idPrefix="grant" value={scopeText} onChange={setScopeText} required={required} allowed={allowed} error={Object.values(scopeText).some(Boolean) ? scope.error : null} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field id="grant-not-before" label="Valid from (optional)">
              <input id="grant-not-before" type="datetime-local" className={inputClass} value={notBefore} onChange={(e) => setNotBefore(e.target.value)} />
            </Field>
            <Field id="grant-expires" label="Expires (optional)" hint="Must be in the future. A short-lived grant is safer, e.g. 72 hours for a first read-only grant" error={dateError}>
              <input id="grant-expires" type="datetime-local" className={inputClass} value={expires} onChange={(e) => setExpires(e.target.value)} />
            </Field>
          </div>
          <p className="font-poppins text-[11px] text-muted-foreground">Requires integration.grants.manage and a recent MFA. The scope must stay within the product&apos;s allowed scope; nobody can grant themselves.</p>
          <ServerError error={mutation.error} />
          <div className="flex justify-end gap-2">
            <button type="button" disabled={mutation.isPending} onClick={onClose} className="h-9 rounded-lg px-4 font-poppins text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={!ready || mutation.isPending} className="h-9 rounded-lg bg-primary px-4 font-poppins text-[13px] font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60">
              {mutation.isPending ? "Working…" : "Create grant"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
