"use client";

// Which products offer a given capability family (e.g. `<product>.verification.read`
// or `<product>.governance.read`), from GET /api/products and each available
// product's live capabilities. Product-neutral; drives product tabs.

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useProducts, productKeys } from "@/lib/products.queries";
import { getProductCapabilities, shouldRetryProductQuery } from "@/lib/products.service";
import type { ProductCapabilities, ProductCapability, ProductScope, ProductSummary, ScopeQuery } from "@/types/products.types";

export interface ProductWithCapability {
  product: ProductSummary;
  /** `<product>.<suffix>`; its state may be blocked (the page shows why). */
  capability: ProductCapability;
  capabilities: ProductCapabilities;
}

export interface ProductDiscoveryOptions {
  /** Products never shown as tabs (e.g. ones the page renders natively). */
  exclude?: string[];
  enabled?: boolean;
}

/** Available products that list `<product>.<suffix>` among their capabilities. */
export function useProductsWithCapability(suffix: string, options: ProductDiscoveryOptions = {}) {
  const enabled = options.enabled ?? true;
  const productsQuery = useProducts({ enabled });
  const exclude = options.exclude;
  const candidates = useMemo(
    () => (productsQuery.data ?? []).filter((p) => p.available && !(exclude ?? []).includes(p.product_id)),
    [productsQuery.data, exclude],
  );
  const capabilityQueries = useQueries({
    queries: candidates.map((p) => ({
      queryKey: productKeys.capabilities(p.product_id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getProductCapabilities(p.product_id, { signal }),
      retry: shouldRetryProductQuery,
      enabled,
    })),
  });

  const products: ProductWithCapability[] = [];
  candidates.forEach((product, i) => {
    const caps = capabilityQueries[i]?.data?.result;
    const capability = caps?.capabilities?.find((c) => c.id === `${product.product_id}.${suffix}`);
    if (caps && capability) products.push({ product, capability, capabilities: caps });
  });

  return {
    products,
    productsQuery,
    loading: productsQuery.isPending || capabilityQueries.some((q) => q.isPending),
    /** Products whose capabilities could not be read (shown as unavailable, never hidden silently by the caller if it wants). */
    failed: candidates.filter((_, i) => capabilityQueries[i]?.isError).map((p) => p.product_id),
  };
}

export type ScopeDim = "market" | "organization" | "zone" | "tenant";
export const SCOPE_DIMS: ScopeDim[] = ["market", "organization", "zone", "tenant"];
const SCOPE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** True when a scope value would be accepted by the gateway. */
export const isScopeValue = (v: string | undefined) => !!v && SCOPE_VALUE.test(v);

/**
 * Selected read/command scope inside the staff member's effective scope.
 * Market and organization default to the first granted value; zone and
 * tenant default to the first value when `requireZoneTenant`, else to "any".
 */
export function useScopeSelection(effective: ProductScope | undefined, requireZoneTenant: boolean) {
  const [chosen, setChosen] = useState<ScopeQuery>({});
  const value = useMemo<ScopeQuery>(() => {
    const out: ScopeQuery = {};
    for (const dim of SCOPE_DIMS) {
      const granted = effective?.[dim] ?? [];
      const picked = chosen[dim];
      const required = dim === "market" || dim === "organization" || requireZoneTenant;
      if (picked !== undefined) out[dim] = picked || undefined;
      else if (granted.length && required) out[dim] = granted[0];
    }
    return out;
  }, [effective, chosen, requireZoneTenant]);
  const set = (dim: ScopeDim, v: string) => setChosen((c) => ({ ...c, [dim]: v }));
  const complete = isScopeValue(value.market) && isScopeValue(value.organization) &&
    (!requireZoneTenant || (isScopeValue(value.zone) && isScopeValue(value.tenant)));
  return { value, set, complete };
}
