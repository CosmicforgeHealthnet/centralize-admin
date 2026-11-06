"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import api from "@/lib/api";

type Scope = Record<string, string[]>;
type Product = { product_id: string; display_name: string; available: boolean; effective_scope: Scope; datasets: { dataset_id: string; granted: boolean }[] };
type Metric = { metric_id: string; definition: string };
type Dataset = { dataset_id: string; metrics: Metric[] };
type Observation = { value: number | null; value_state: string; source_observed_at: string | null; freshness: string; coverage: string };
type Card = Metric & { observation: Observation | null };
type Group = { product: Product; cards: Card[] };
type Envelope<T> = { result: T | null; error: unknown };
const label = (id: string) => id.split(".").at(-1)!.replaceAll("_", " ");

export default function ProductMetrics() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const { data } = await api.get<{ products: Product[] }>("/api/products", { signal });
      const products = (data.products || []).filter(p => p.available && p.datasets.some(d => d.granted));
      const next = await Promise.all(products.map(async product => {
        const { data: catalog } = await api.get<Envelope<{ datasets: Dataset[] }>>(`/api/products/${encodeURIComponent(product.product_id)}/datasets`, { signal });
        if (!catalog.result || catalog.error) throw new Error("Product data unavailable");
        const metrics = catalog.result.datasets.flatMap(d => d.metrics);
        const cards = await Promise.all(metrics.map(async metric => {
          try {
            const { data: response } = await api.get<Envelope<{ observations: Observation[] }>>(`/api/products/${encodeURIComponent(product.product_id)}/metrics/${encodeURIComponent(metric.metric_id)}`, { signal, params: { limit: 1 } });
            return { ...metric, observation: response.error ? null : response.result?.observations[0] ?? null };
          } catch { return { ...metric, observation: null }; }
        }));
        return { product, cards };
      }));
      if (!signal.aborted) { setGroups(next); setFailed(false); }
    } catch {
      if (!signal.aborted) { setGroups([]); setFailed(true); }
    } finally { if (!signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => { void load(controller.signal); }, 60000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);
  const refresh = () => { void load(new AbortController().signal); };
  if (!groups.length && !failed) return null;
  return <section aria-label="Product activity" className="rounded-xl border border-border bg-card p-4 text-card-foreground">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold">Product activity</h2>
      <button type="button" onClick={refresh} disabled={loading} aria-label="Refresh product activity" className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
      </button>
    </div>
    {failed ? <p role="status" className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />Product data is unavailable. Try refreshing.</p> : groups.map(({ product, cards }) => <div key={product.product_id} className="mt-3">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-medium">{product.display_name}</h3>
        <p className="text-xs text-muted-foreground">Source: {product.display_name} Admin ? {product.effective_scope.market?.join(", ")} ? {product.effective_scope.tenant?.join(", ")}</p>
      </div>
      <dl className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ metric_id, definition, observation }) => {
          const observed = observation?.value_state === "OBSERVED" && observation.value !== null;
          const fresh = observed && observation?.freshness === "FRESH";
          return <div key={metric_id} className="min-w-0 rounded-lg border border-border p-3">
            <dt title={definition} className="text-xs capitalize text-muted-foreground">{label(metric_id)}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{observed ? observation!.value!.toLocaleString() : "?"}</dd>
            <p className={`mt-1 text-xs ${fresh ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
              {!observed ? "Unavailable" : `${fresh ? "Fresh" : "Stale"} ? ${observation?.coverage === "COMPLETE" ? "Complete" : "Partial"} coverage`}
            </p>
            {observation?.source_observed_at && <p className="mt-1 text-xs text-muted-foreground">Observed <time dateTime={observation.source_observed_at}>{new Date(observation.source_observed_at).toLocaleString()}</time></p>}
          </div>;
        })}
      </dl>
    </div>)}
  </section>;
}
