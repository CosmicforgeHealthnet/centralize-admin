"use client";

// Verification cases of one product (generalized Verification page, design
// §10): the paged case queue, one case with its evidence (hashes only) and
// history, and the case actions. Reads go through
// /api/products/{p}/resources/{p}.verification.read/... with the exact
// market, organization, zone and tenant and the fixed purpose.

import { useMemo, useState } from "react";
import { ArrowLeft, FileCheck2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import CapabilityNotice, { capabilityUsable } from "@/components/approvals/CapabilityNotice";
import { Meta, TimeText } from "@/components/approvals/ApprovalCard";
import ScopeBar from "@/components/approvals/ScopeBar";
import { MfaStepUpProvider } from "@/components/products/MfaStepUp";
import ProductDataState, { RefreshButton } from "@/components/products/ProductDataState";
import ServiceDataState from "@/components/shared/ServiceDataState";
import { useProductResource, useProductResourcesInfinite } from "@/lib/products.queries";
import { useScopeSelection, type ProductWithCapability } from "@/lib/products.discovery";
import { qualityOf } from "@/lib/products.service";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth.store";
import type { CommandScope, ProductCapabilities, ResourceDetailQuery } from "@/types/products.types";
import CaseActions from "./CaseActions";
import {
  actorLabel,
  CASE_KINDS,
  CASE_STATES,
  collectionExposure,
  COLLECTIONS,
  KIND_LABEL,
  STATE_LABEL,
  VERIFICATION_PURPOSE,
  verificationReadCapability,
  type CaseHistoryData,
  type CaseListData,
  type VerificationCase,
  type VerificationCaseDetail,
} from "./verification-cases";

const selectClass = "h-8 rounded-md border border-border bg-background px-2 font-poppins text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const STATE_TONE: Record<string, string> = {
  OPEN: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
  CLAIMED: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  PUBLISHED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  SUSPENDED: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  CANCELLED: "bg-muted text-muted-foreground",
};

export function CaseStateBadge({ state }: { state: string }) {
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 font-poppins text-[10px] font-semibold", STATE_TONE[state] ?? "bg-muted text-foreground")}>{STATE_LABEL[state] ?? state}</span>;
}

function CollectionBlocked({ title, state }: { title: string; state: string }) {
  return (
    <section role="alert" className="rounded-lg border border-border bg-card p-3 text-center font-poppins text-[12px] text-muted-foreground">
      {title} blocked: this collection is <span className="font-mono">{state}</span> at the product.
    </section>
  );
}

// ── Case list ─────────────────────────────────────────────────────

function CaseList({ productId, query, capabilities, onOpen }: { productId: string; query: ResourceDetailQuery; capabilities: ProductCapabilities; onOpen: (id: string) => void }) {
  const readCap = verificationReadCapability(productId);
  const exposure = collectionExposure(capabilities, readCap, COLLECTIONS.list);
  const blocked = exposure !== null && exposure !== "READ_ONLY";
  const list = useProductResourcesInfinite<CaseListData>(productId, readCap, COLLECTIONS.list, { ...query, limit: 50 }, { enabled: !blocked });
  const [state, setState] = useState("");
  const [kind, setKind] = useState("");
  const pages = list.data?.pages ?? [];
  const all = pages.flatMap((p) => p.result.data?.items ?? []);
  // The source offers no state/kind filter: filter the loaded cases here.
  const items = all.filter((c) => (!state || c.state === state) && (!kind || c.kind === kind));

  if (blocked) return <CollectionBlocked title="Verification cases" state={exposure} />;

  return (
    <section aria-label="Verification cases" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">State</span>
            <select className={selectClass} value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
              <option value="">All states</option>
              {CASE_STATES.filter((s) => s !== "CANCELLED").map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Kind</span>
            <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
              <option value="">All kinds</option>
              {CASE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
        </div>
        <RefreshButton onClick={() => void list.refetch()} busy={list.isFetching} label="Refresh cases" />
      </div>
      <ProductDataState
        title="Verification cases"
        loading={list.isPending}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={!!list.data && all.length === 0}
        emptyMessage="No verification cases are waiting in this scope."
        quality={pages[0] ? qualityOf(pages[0]) : null}
      >
        <p className="font-poppins text-[11px] text-muted-foreground">
          {items.length} of {all.length} loaded {all.length === 1 ? "case" : "cases"}
          {state || kind ? " match the filters (filters apply to loaded cases)" : ""}
          {list.hasNextPage ? " · more available" : ""}
        </p>
        <div className="overflow-x-auto rounded-[10px] border border-border">
          <table className="w-full min-w-[640px] text-left font-poppins text-[12px]">
            <thead className="bg-muted/40 text-[11px] text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Case</th>
                <th scope="col" className="px-3 py-2 font-medium">Kind</th>
                <th scope="col" className="px-3 py-2 font-medium">State</th>
                <th scope="col" className="px-3 py-2 font-medium">Version</th>
                <th scope="col" className="px-3 py-2 font-medium">Assignee</th>
                <th scope="col" className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c: VerificationCase) => (
                <tr key={c.case_id} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => onOpen(c.case_id)} className="break-all text-left font-mono text-[11px] font-semibold text-primary underline-offset-2 hover:underline">
                      {c.case_id}
                    </button>
                  </td>
                  <td className="px-3 py-2">{KIND_LABEL[c.kind] ?? c.kind}</td>
                  <td className="px-3 py-2"><CaseStateBadge state={c.state} /></td>
                  <td className="px-3 py-2">{c.version}</td>
                  <td className="break-all px-3 py-2">{c.assignee_ref ?? "Unassigned"}</td>
                  <td className="px-3 py-2"><TimeText iso={c.updated_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {items.length === 0 && all.length > 0 && <p className="font-poppins text-[12px] text-muted-foreground">No loaded case matches these filters.</p>}
        {list.hasNextPage && (
          <button
            type="button"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            className="mt-2 self-center rounded-md border border-border px-3 py-1.5 font-poppins text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-60"
          >
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        )}
      </ProductDataState>
    </section>
  );
}

// ── Case detail ───────────────────────────────────────────────────

function CaseHistory({ productId, caseId, query, capabilities, staffId }: { productId: string; caseId: string; query: ResourceDetailQuery; capabilities: ProductCapabilities; staffId: string | null }) {
  const readCap = verificationReadCapability(productId);
  const exposure = collectionExposure(capabilities, readCap, COLLECTIONS.history);
  const blocked = exposure !== null && exposure !== "READ_ONLY";
  const history = useProductResourcesInfinite<CaseHistoryData>(productId, readCap, COLLECTIONS.history, { ...query, parent: caseId, limit: 50 }, { enabled: !blocked });
  const pages = history.data?.pages ?? [];
  const items = pages.flatMap((p) => p.result.data?.items ?? []);
  if (blocked) return <CollectionBlocked title="Case history" state={exposure} />;
  return (
    <section aria-label="Case history" className="flex flex-col gap-2">
      <h3 className="font-poppins text-[13px] font-semibold text-foreground">History</h3>
      <ProductDataState title="Case history" loading={history.isPending} error={history.error} onRetry={() => history.refetch()} empty={!!history.data && items.length === 0} quality={pages[0] ? qualityOf(pages[0]) : null} compact>
        <ol className="flex flex-col gap-2">
          {items.map((h) => (
            <li key={h.sequence} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border p-2 font-poppins text-[12px]">
              <span className="text-foreground">
                <span className="text-muted-foreground">#{h.sequence}</span> {h.from_state ? STATE_LABEL[h.from_state] ?? h.from_state : "Created"} → {h.to_state ? STATE_LABEL[h.to_state] ?? h.to_state : "—"}
                {h.reason_code && <span className="ml-1 font-mono text-[11px] text-muted-foreground">{h.reason_code}</span>}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {h.actor_kind === "STAFF" ? actorLabel(h.actor_ref, staffId) : h.actor_kind === "PARTNER" ? "Partner" : "System"} · <TimeText iso={h.occurred_at} />
              </span>
            </li>
          ))}
        </ol>
        {history.hasNextPage && (
          <button type="button" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage} className="self-center rounded-md border border-border px-3 py-1.5 font-poppins text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
            {history.isFetchingNextPage ? "Loading…" : "Load more history"}
          </button>
        )}
      </ProductDataState>
    </section>
  );
}

function CaseDetail({
  productId,
  caseId,
  query,
  scope,
  capabilities,
  staffId,
  onBack,
}: {
  productId: string;
  caseId: string;
  query: ResourceDetailQuery;
  scope: CommandScope;
  capabilities: ProductCapabilities;
  staffId: string | null;
  onBack: () => void;
}) {
  const readCap = verificationReadCapability(productId);
  const queryClient = useQueryClient();
  const exposure = collectionExposure(capabilities, readCap, COLLECTIONS.detail);
  const blocked = exposure !== null && exposure !== "READ_ONLY";
  const detail = useProductResource<VerificationCaseDetail>(productId, readCap, COLLECTIONS.detail, caseId, query, { enabled: !blocked });
  const c = detail.data?.result.data;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["products", "product", productId, "resources", readCap] });

  return (
    <section aria-label="Verification case" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 font-poppins text-[12px] font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to cases
        </button>
        <RefreshButton onClick={refresh} busy={detail.isFetching} label="Refresh case" />
      </div>
      {blocked ? (
        <CollectionBlocked title="Case detail" state={exposure} />
      ) : (
        <ProductDataState title="Verification case" loading={detail.isPending} error={detail.error} onRetry={() => detail.refetch()} quality={detail.data ? qualityOf(detail.data) : null}>
          {c && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <h2 className="font-poppins text-[14px] font-semibold text-foreground">{KIND_LABEL[c.kind] ?? c.kind}</h2>
                    <span className="break-all font-mono text-[11px] text-muted-foreground">{c.case_id}</span>
                  </div>
                  <CaseStateBadge state={c.state} />
                </div>
                {c.state === "CANCELLED" && (
                  <p role="status" className="rounded-md bg-muted/50 p-2 font-poppins text-[12px] text-foreground">Withdrawn by the partner.</p>
                )}
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Meta label="Version">{c.version}</Meta>
                  <Meta label="Assignee">{c.assignee_ref ? actorLabel(c.assignee_ref, staffId) : "Unassigned"}</Meta>
                  <Meta label="Approvals required">{c.approvals_required}</Meta>
                  <Meta label="Subject">{c.subject_ref}</Meta>
                  <Meta label="Partner tenant">{c.partner_tenant_id}</Meta>
                  <Meta label="Submitted"><TimeText iso={c.submitted_at} /></Meta>
                  <Meta label="Updated"><TimeText iso={c.updated_at} /></Meta>
                  {"app_version" in c.details && (
                    <>
                      <Meta label="App version under review">{c.details.app_version}</Meta>
                      <Meta label="Published version">{c.details.published_version ?? "None"}</Meta>
                    </>
                  )}
                </dl>
                {"requested_capabilities" in c.details && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Meta label="Requested capabilities">{c.details.requested_capabilities.length ? c.details.requested_capabilities.join(", ") : "None"}</Meta>
                    <Meta label="Approved capabilities">{c.details.approved_capabilities.length ? c.details.approved_capabilities.join(", ") : "None yet"}</Meta>
                  </div>
                )}
              </div>

              <section aria-label="Evidence" className="flex flex-col gap-2">
                <h3 className="font-poppins text-[13px] font-semibold text-foreground">Evidence</h3>
                <p className="font-poppins text-[11px] text-muted-foreground">Only references and SHA-256 hashes are shared with HQ; the documents stay with the product.</p>
                {c.evidence.length === 0 ? (
                  <p className="font-poppins text-[12px] text-muted-foreground">No evidence was attached.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {c.evidence.map((e) => (
                      <li key={e.ref} className="flex flex-col gap-0.5 rounded-md border border-border p-2">
                        <span className="flex items-center gap-1.5 font-poppins text-[12px] font-medium text-foreground">
                          <FileCheck2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /> {e.kind}
                        </span>
                        <span className="break-all font-mono text-[11px] text-muted-foreground">Ref {e.ref}</span>
                        <span className="break-all font-mono text-[11px] text-foreground">sha256 {e.sha256}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-label="Actions" className="flex flex-col gap-2">
                <h3 className="font-poppins text-[13px] font-semibold text-foreground">Actions</h3>
                <CaseActions productId={productId} item={c} capabilities={capabilities} scope={scope} readQuery={query} staffId={staffId} onRefresh={refresh} />
              </section>

              <CaseHistory productId={productId} caseId={c.case_id} query={query} capabilities={capabilities} staffId={staffId} />
            </div>
          )}
        </ProductDataState>
      )}
    </section>
  );
}

// ── Section ───────────────────────────────────────────────────────

function Section({ entry, caseId, onCaseChange }: { entry: ProductWithCapability; caseId: string | null; onCaseChange: (id: string | null) => void }) {
  const productId = entry.product.product_id;
  const staffId = useAuthStore((s) => (s.user?.id ? String(s.user.id) : null));
  const scope = useScopeSelection(entry.product.effective_scope, true);
  const open = (id: string | null) => onCaseChange(id);

  const query = useMemo<ResourceDetailQuery>(
    () => ({ market: scope.value.market ?? "", organization: scope.value.organization ?? "", zone: scope.value.zone, tenant: scope.value.tenant, purpose: VERIFICATION_PURPOSE }),
    [scope.value],
  );
  const commandScope = useMemo<CommandScope>(() => ({
    market: [scope.value.market ?? ""],
    organization: [scope.value.organization ?? ""],
    ...(scope.value.zone ? { zone: [scope.value.zone] } : {}),
    ...(scope.value.tenant ? { tenant: [scope.value.tenant] } : {}),
  }), [scope.value]);

  if (!capabilityUsable(entry.capability)) return <CapabilityNotice title={`${entry.product.display_name ?? productId} verification`} capability={entry.capability} />;

  return (
    <div className="flex flex-col gap-4">
      <ScopeBar effective={entry.product.effective_scope} value={scope.value} onChange={(dim, v) => scope.set(dim, v)} requireZoneTenant label="Verification scope" />
      {!scope.complete ? (
        <ServiceDataState empty title="Choose a scope" message="Verification cases need a market, organization, zone and tenant." compact />
      ) : caseId ? (
        <CaseDetail productId={productId} caseId={caseId} query={query} scope={commandScope} capabilities={entry.capabilities} staffId={staffId} onBack={() => open(null)} />
      ) : (
        <CaseList productId={productId} query={query} capabilities={entry.capabilities} onOpen={(id) => open(id)} />
      )}
    </div>
  );
}

export interface ProductVerificationSectionProps {
  entry: ProductWithCapability;
  /** The open case (controlled by the page, mirrored in `?case=`). */
  caseId: string | null;
  onCaseChange: (caseId: string | null) => void;
}

export default function ProductVerificationSection({ entry, caseId, onCaseChange }: ProductVerificationSectionProps) {
  const name = entry.product.display_name ?? entry.product.product_id;
  return (
    <MfaStepUpProvider description="Verification actions need a recent confirmation. Enter the 6-digit code from your authenticator app.">
      <div className="flex flex-col gap-4 rounded-[12px] border border-border bg-card p-4 sm:p-5">
        <div>
          <h1 className="font-poppins text-[15px] font-semibold text-foreground">{name} verification</h1>
          <p className="mt-0.5 font-poppins text-[12px] text-muted-foreground">
            Review cases, check evidence hashes and history. Approvals and rejections need a second staff member.
          </p>
        </div>
        <Section entry={entry} caseId={caseId} onCaseChange={onCaseChange} />
      </div>
    </MfaStepUpProvider>
  );
}
