"use client";

// CF Meet overview: one card per approved dataset metric (latest observation
// for the selected exact scope) with its as-of time, freshness and coverage,
// plus the state of every module. An unavailable figure is shown as
// unavailable, never as zero.

import Link from "next/link";
import FreshnessBadge, { observationQuality } from "@/components/products/FreshnessBadge";
import ProductDataState, { ErrorReference } from "@/components/products/ProductDataState";
import { useMetricObservations, useProductDatasets } from "@/lib/products.queries";
import { describeProductError, toProductApiError } from "@/lib/products.service";
import type { ProductDataset, ProductMetricDefinition, ProductSummary } from "@/types/products.types";
import { BlockerList, StateBadge } from "./CfMeetBlocked";
import { sectionHref } from "./CfMeetSubNav";
import { CFMEET_PRODUCT_ID, capabilityById, isUsableState, missingDimensions, moduleById, scopeQuery, type CfMeetCapabilities, type CfMeetScope } from "./catalog";
import { Money, humanize } from "./format";
import { CFMEET_SECTIONS } from "./sections";

const metricLabel = (id: string) => humanize(id.split(".").at(-1) ?? id);

function MetricCard({ dataset, metric, scope }: { dataset: ProductDataset; metric: ProductMetricDefinition; scope: CfMeetScope }) {
  const dims = dataset.scope_dimensions?.length ? dataset.scope_dimensions : (["market", "organization", "zone", "tenant"] as const);
  const missing = missingDimensions(scope, dims);
  const q = useMetricObservations(CFMEET_PRODUCT_ID, metric.metric_id, { ...scopeQuery(scope, dims), limit: 1 }, { enabled: missing.length === 0 });
  const obs = q.data?.result.observations[0] ?? null;
  const observed = obs?.value_state === "OBSERVED" && obs.value !== null;
  const error = q.error ? toProductApiError(q.error) : null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border p-3" data-metric={metric.metric_id}>
      <dt title={metric.definition} className="text-xs text-muted-foreground">{metricLabel(metric.metric_id)}</dt>
      <dd className="flex flex-col gap-1.5">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {q.isPending && missing.length === 0 ? (
            <span className="text-sm text-muted-foreground">Loading…</span>
          ) : observed ? (
            obs.currency && obs.unit === "minor_currency" ? <Money minor={obs.value as number} currency={obs.currency} /> : (obs.value as number).toLocaleString()
          ) : (
            <span className="text-base text-muted-foreground">Unavailable</span>
          )}
        </span>
        {obs ? (
          <FreshnessBadge quality={observationQuality(obs)} compact />
        ) : q.data ? (
          <FreshnessBadge quality={q.data} compact />
        ) : null}
        {missing.length > 0 && <p className="text-[11px] text-muted-foreground">Needs one exact {missing.join(", ")} in your grant.</p>}
        {error && (
          <>
            <p className="text-[11px] text-muted-foreground">{error.reason === "NO_SOURCE_OBSERVATION" ? "No source observation for this scope yet." : describeProductError(error)}</p>
            <ErrorReference error={error} />
          </>
        )}
        <p className="text-[10px] text-muted-foreground">
          {metric.unit}
          {metric.grain ? ` · per ${metric.grain.toLowerCase()}` : ""}
          {obs ? ` · window ${new Date(obs.window_start).toLocaleDateString()}` : ""}
        </p>
      </dd>
    </div>
  );
}

function DatasetMetrics({ product, scope }: { product: ProductSummary; scope: CfMeetScope }) {
  const datasets = useProductDatasets(CFMEET_PRODUCT_ID);
  const granted = new Set((product.datasets ?? []).filter((d) => d.granted).map((d) => d.dataset_id));
  const list = datasets.data?.result.datasets ?? [];
  const visible = list.filter((d) => granted.has(d.dataset_id));
  const hidden = list.filter((d) => !granted.has(d.dataset_id));
  return (
    <section aria-label="CF Meet metrics" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-[15px] font-semibold text-foreground">Metrics</h2>
      <ProductDataState
        title="CF Meet datasets"
        loading={datasets.isPending}
        error={datasets.error}
        onRetry={() => datasets.refetch()}
        empty={!!datasets.data && visible.length === 0}
        emptyMessage={list.length ? "You hold no dataset grant for CF Meet metrics." : "CF Meet has no approved datasets yet."}
        compact
        embedded
      >
        <div className="flex flex-col gap-4">
          {visible.map((d) => (
            <div key={d.dataset_id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="font-mono text-[12px] font-semibold text-foreground">{d.dataset_id}</h3>
                <span className="text-[11px] text-muted-foreground">
                  Sync coverage {d.synchronization?.coverage ?? "UNKNOWN"} · {d.synchronization?.gap_status ?? "gap status unknown"}
                </span>
              </div>
              {d.metrics.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No metrics in this dataset.</p>
              ) : (
                <dl className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {d.metrics.map((m) => (
                    <MetricCard key={m.metric_id} dataset={d} metric={m} scope={scope} />
                  ))}
                </dl>
              )}
            </div>
          ))}
          {hidden.length > 0 && <p className="text-[11px] text-muted-foreground">{hidden.length} other dataset{hidden.length === 1 ? "" : "s"} need a dataset grant.</p>}
        </div>
      </ProductDataState>
    </section>
  );
}

function ModuleStatus({ caps }: { caps: CfMeetCapabilities }) {
  return (
    <section aria-label="CF Meet modules" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">Modules</h2>
        {caps.bridge_contract?.contract && (
          <span className="text-[11px] text-muted-foreground">
            Contract {caps.bridge_contract.contract} {caps.bridge_contract.contract_version}
            {caps.bridge_live?.state ? ` · Bridge ${caps.bridge_live.state.replaceAll("_", " ").toLowerCase()}` : ""}
          </span>
        )}
      </div>
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {CFMEET_SECTIONS.flatMap((s) =>
          s.modules.map((moduleId) => {
            const m = moduleById(caps, moduleId);
            const cap = m ? capabilityById(caps, m.read_capability_id) : null;
            const state = cap?.state ?? "UNAVAILABLE";
            const readable = m ? m.collections.filter((c) => isUsableState(c.exposure_state)).length : 0;
            return (
              <li key={`${s.id}:${moduleId}`} className="flex flex-col gap-1 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={sectionHref(s.id)} scroll={false} className="text-[13px] font-semibold text-foreground hover:underline">{m?.title ?? humanize(moduleId)}</Link>
                  <StateBadge state={state} />
                </div>
                <p className="text-[11px] text-muted-foreground">{m ? `${readable} of ${m.collections.length} collections readable` : "Not in the active contract"}</p>
                {cap && !isUsableState(state) && <BlockerList blockers={cap.blockers} />}
              </li>
            );
          }),
        )}
      </ul>
    </section>
  );
}

export default function CfMeetOverview({ product, caps, scope }: { product: ProductSummary; caps: CfMeetCapabilities | undefined; scope: CfMeetScope }) {
  return (
    <div className="flex flex-col gap-4">
      <DatasetMetrics product={product} scope={scope} />
      {caps && <ModuleStatus caps={caps} />}
    </div>
  );
}
