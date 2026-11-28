"use client";

// React Query hooks over lib/products.service.ts. Product-neutral.
//
//  - Reads never auto-retry on 4xx, MFA, scope or policy refusals
//    (shouldRetryProductQuery); network failures and retryable 5xx retry twice.
//  - Operation submits are never retried and never resent. An unknown outcome
//    is settled by reading the operation back (useOperation /
//    OperationStatusDrawer).
//  - `stepUp: true` (default for grant views) asks for an MFA step-up when a
//    read is refused for a missing recent MFA and retries it once. It needs an
//    MfaStepUpProvider above the component; without one the error surfaces.

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useMfaStepUp } from "@/lib/mfa-step-up";
import * as products from "@/lib/products.service";
import type {
  GrantListQuery,
  MetricQuery,
  OperationCommand,
  OperationView,
  ProductCapabilities,
  ProductEnvelopeOk,
  ProductGrantList,
  ReportQuery,
  ResourceDetailQuery,
  ResourceListQuery,
  ResourceRead,
} from "@/types/products.types";

/** Resource payloads may hold personal data: keep them in memory briefly once unused. */
const RESOURCE_GC_TIME = 5 * 60 * 1000;
/** Operation statuses that are not final yet. */
export const UNSETTLED_OPERATION_STATUSES: readonly string[] = ["RECORDED", "DISPATCHING", "UNKNOWN_OUTCOME"];

/** Options accepted by every read hook. */
export interface ProductQueryOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  /** Ask for an MFA step-up and retry once when the read is refused for a missing recent MFA. */
  stepUp?: boolean;
}

/** Query keys. Invalidate `productKeys.product(id)` to refresh everything of one product. */
export const productKeys = {
  all: ["products"] as const,
  list: () => ["products", "list"] as const,
  product: (productId: string) => ["products", "product", productId] as const,
  manifest: (productId: string) => ["products", "product", productId, "manifest"] as const,
  capabilities: (productId: string) => ["products", "product", productId, "capabilities"] as const,
  datasets: (productId: string) => ["products", "product", productId, "datasets"] as const,
  eventsStatus: (productId: string) => ["products", "product", productId, "events-status"] as const,
  metric: (productId: string, metricId: string, query: MetricQuery) => ["products", "product", productId, "metric", metricId, query] as const,
  resources: (productId: string, capabilityId: string, collectionId: string) => ["products", "product", productId, "resources", capabilityId, collectionId] as const,
  resourcePage: (productId: string, capabilityId: string, collectionId: string, query: ResourceListQuery) =>
    ["products", "product", productId, "resources", capabilityId, collectionId, "page", query] as const,
  resourcePages: (productId: string, capabilityId: string, collectionId: string, query: Omit<ResourceListQuery, "continuation">) =>
    ["products", "product", productId, "resources", capabilityId, collectionId, "pages", query] as const,
  resource: (productId: string, capabilityId: string, collectionId: string, resourceId: string, query: ResourceDetailQuery) =>
    ["products", "product", productId, "resources", capabilityId, collectionId, "item", resourceId, query] as const,
  report: (productId: string, reportId: string, query: ReportQuery) => ["products", "product", productId, "report", reportId, query] as const,
  operation: (productId: string, operationId: string) => ["products", "product", productId, "operation", operationId] as const,
  operationAudit: (productId: string, operationId: string) => ["products", "product", productId, "operation", operationId, "audit"] as const,
  grants: (productId: string) => ["products", "product", productId, "grants"] as const,
  grantList: (productId: string, query: GrantListQuery) => ["products", "product", productId, "grants", "list", query] as const,
  grantPages: (productId: string, query: Omit<GrantListQuery, "cursor">) => ["products", "product", productId, "grants", "pages", query] as const,
  grant: (productId: string, grantId: string) => ["products", "product", productId, "grants", "item", grantId] as const,
};

function useRunner(stepUp: boolean | undefined) {
  const { withStepUp } = useMfaStepUp();
  return <T,>(fn: () => Promise<T>) => (stepUp ? withStepUp(fn) : fn());
}

// Only defined options are passed, so QueryClient defaults (e.g. staleTime) still apply.
const common = (o: ProductQueryOptions) => ({
  ...(o.enabled !== undefined && { enabled: o.enabled }),
  ...(o.staleTime !== undefined && { staleTime: o.staleTime }),
  ...(o.refetchInterval !== undefined && { refetchInterval: o.refetchInterval }),
  retry: products.shouldRetryProductQuery,
});

// ── Navigation and catalog ────────────────────────────────────────

/** Products the staff member can see (drives product navigation; never staff tier). */
export function useProducts(options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.list(),
    queryFn: ({ signal }) => run(() => products.listProducts({ signal })),
    ...common(options),
  });
}

export function useProductManifest(productId: string, options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.manifest(productId),
    queryFn: ({ signal }) => run(() => products.getProductManifest(productId, { signal })),
    ...common(options),
  });
}

export function useProductCapabilities<T extends ProductCapabilities = ProductCapabilities>(productId: string, options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.capabilities(productId),
    queryFn: ({ signal }) => run(() => products.getProductCapabilities<T>(productId, { signal })),
    ...common(options),
  });
}

export function useProductDatasets(productId: string, options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.datasets(productId),
    queryFn: ({ signal }) => run(() => products.getProductDatasets(productId, { signal })),
    ...common(options),
  });
}

export function useMetricObservations(productId: string, metricId: string, query: MetricQuery = {}, options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.metric(productId, metricId, query),
    queryFn: ({ signal }) => run(() => products.getMetricObservations(productId, metricId, query, { signal })),
    ...common(options),
  });
}

export function useEventsStatus(productId: string, options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.eventsStatus(productId),
    queryFn: ({ signal }) => run(() => products.getEventsStatus(productId, { signal })),
    ...common(options),
  });
}

// ── Resources and reports ─────────────────────────────────────────

/** One page of a scoped list (pass `query.continuation` yourself, or use useProductResourcesInfinite). */
export function useProductResources<TData = unknown>(
  productId: string,
  capabilityId: string,
  collectionId: string,
  query: ResourceListQuery,
  options: ProductQueryOptions = {},
) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.resourcePage(productId, capabilityId, collectionId, query),
    queryFn: ({ signal }) => run(() => products.listResources<TData>(productId, capabilityId, collectionId, query, { signal })),
    gcTime: RESOURCE_GC_TIME,
    ...common(options),
  });
}

/**
 * Continuation-paged list. `data.pages` holds one envelope per page;
 * `fetchNextPage()` follows `result.continuation`; `hasNextPage` is false once
 * the Product Admin returns no continuation. Contact-like `q` goes by POST.
 */
export function useProductResourcesInfinite<TData = unknown>(
  productId: string,
  capabilityId: string,
  collectionId: string,
  query: Omit<ResourceListQuery, "continuation">,
  options: ProductQueryOptions = {},
) {
  const run = useRunner(options.stepUp);
  return useInfiniteQuery<
    ProductEnvelopeOk<ResourceRead<TData>>,
    products.ProductApiError,
    InfiniteData<ProductEnvelopeOk<ResourceRead<TData>>, string | undefined>,
    ReturnType<typeof productKeys.resourcePages>,
    string | undefined
  >({
    queryKey: productKeys.resourcePages(productId, capabilityId, collectionId, query),
    queryFn: ({ signal, pageParam }) =>
      run(() => products.listResources<TData>(productId, capabilityId, collectionId, { ...query, continuation: pageParam }, { signal })),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.result.continuation || undefined,
    gcTime: RESOURCE_GC_TIME,
    ...common(options),
  });
}

export function useProductResource<TData = unknown>(
  productId: string,
  capabilityId: string,
  collectionId: string,
  resourceId: string,
  query: ResourceDetailQuery,
  options: ProductQueryOptions = {},
) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.resource(productId, capabilityId, collectionId, resourceId, query),
    queryFn: ({ signal }) => run(() => products.getResource<TData>(productId, capabilityId, collectionId, resourceId, query, { signal })),
    gcTime: RESOURCE_GC_TIME,
    ...common(options),
  });
}

export function useProductReport<TResult = unknown>(productId: string, reportId: string, query: ReportQuery, options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.report(productId, reportId, query),
    queryFn: ({ signal }) => run(() => products.getReport<TResult>(productId, reportId, query, { signal })),
    ...common(options),
  });
}

// ── Operations ────────────────────────────────────────────────────

export interface OperationQueryOptions extends ProductQueryOptions {
  /** Re-read (which triggers the Product Admin's authoritative readback) every N ms while the status is unsettled. Off by default. */
  pollUnsettledMs?: number;
}

/** GET operation. Each read lets the Product Admin settle an UNKNOWN_OUTCOME by readback; it never resends the command. */
export function useOperation(productId: string, operationId: string | null | undefined, options: OperationQueryOptions = {}) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.operation(productId, operationId ?? ""),
    queryFn: ({ signal }) => run(() => products.getOperation(productId, operationId as string, { signal })),
    ...common(options),
    enabled: (options.enabled ?? true) && !!operationId,
    refetchInterval: (q) => {
      const status = q.state.data?.result.status;
      if (options.pollUnsettledMs && status && UNSETTLED_OPERATION_STATUSES.includes(status)) return options.pollUnsettledMs;
      return options.refetchInterval ?? false;
    },
  });
}

export function useOperationAudit(productId: string, operationId: string | null | undefined, options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp);
  return useQuery({
    queryKey: productKeys.operationAudit(productId, operationId ?? ""),
    queryFn: ({ signal }) => run(() => products.getOperationAudit(productId, operationId as string, { signal })),
    ...common(options),
    enabled: (options.enabled ?? true) && !!operationId,
  });
}

export interface SubmitOperationOptions {
  /** Step up and resend the SAME command once when it is refused for a missing recent MFA (default true). */
  stepUp?: boolean;
  onSuccess?: (result: products.OperationSubmitResult, command: OperationCommand) => void;
  onError?: (error: products.ProductApiError, command: OperationCommand) => void;
}

/**
 * Submits a prebuilt command (buildOperationCommand) exactly once.
 *
 * - `retry: false`: React Query never resends it.
 * - An MFA refusal is a definite refusal before anything ran, so after the
 *   step-up the identical command (same command_id and idempotency_key) is
 *   sent once more; the Product Admin treats a duplicate as a replay.
 * - On kind "unknown_outcome" the error carries `operation_id`: open
 *   OperationStatusDrawer for it. Never call mutate again with a new command
 *   for the same intent until the readback settles it.
 */
export function useSubmitProductOperation(productId: string, options: SubmitOperationOptions = {}) {
  const queryClient = useQueryClient();
  const { withStepUp } = useMfaStepUp();
  const stepUp = options.stepUp ?? true;
  return useMutation<products.OperationSubmitResult, products.ProductApiError, OperationCommand>({
    mutationKey: ["products", "product", productId, "operation-submit"],
    retry: false,
    mutationFn: async (command) => {
      const send = () => products.submitOperation(productId, command);
      try {
        return await (stepUp ? withStepUp(send) : send());
      } catch (err) {
        throw products.toProductApiError(err);
      }
    },
    onSuccess: (result, command) => {
      queryClient.setQueryData<ProductEnvelopeOk<OperationView>>(productKeys.operation(productId, result.operation.operation_id), result.envelope);
      void queryClient.invalidateQueries({ queryKey: productKeys.operationAudit(productId, result.operation.operation_id) });
      options.onSuccess?.(result, command);
    },
    onError: (error, command) => {
      const operationId = error.operation_id ?? (error.kind === "unknown_outcome" ? command.command_id : null);
      if (operationId) void queryClient.invalidateQueries({ queryKey: productKeys.operation(productId, operationId) });
      options.onError?.(error, command);
    },
  });
}

// ── Grants (read-only; recent MFA required) ───────────────────────

const grantDefaults = (o: ProductQueryOptions) => ({ ...o, stepUp: o.stepUp ?? true });

/** One page of a product's staff grants. Steps up by default (the route needs a recent MFA). */
export function useProductGrants(productId: string, query: GrantListQuery = {}, options: ProductQueryOptions = {}) {
  const o = grantDefaults(options);
  const run = useRunner(o.stepUp);
  return useQuery({
    queryKey: productKeys.grantList(productId, query),
    queryFn: ({ signal }) => run(() => products.listProductGrants(productId, query, { signal })),
    refetchOnWindowFocus: false,
    ...common(o),
  });
}

/** Cursor-paged grant list (`next_cursor`). */
export function useProductGrantsInfinite(productId: string, query: Omit<GrantListQuery, "cursor"> = {}, options: ProductQueryOptions = {}) {
  const o = grantDefaults(options);
  const run = useRunner(o.stepUp);
  return useInfiniteQuery<
    ProductGrantList,
    products.ProductApiError,
    InfiniteData<ProductGrantList, string | undefined>,
    ReturnType<typeof productKeys.grantPages>,
    string | undefined
  >({
    queryKey: productKeys.grantPages(productId, query),
    queryFn: ({ signal, pageParam }) => run(() => products.listProductGrants(productId, { ...query, cursor: pageParam }, { signal })),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.next_cursor || undefined,
    refetchOnWindowFocus: false,
    ...common(o),
  });
}

export function useProductGrant(productId: string, grantId: string | null | undefined, options: ProductQueryOptions = {}) {
  const o = grantDefaults(options);
  const run = useRunner(o.stepUp);
  return useQuery({
    queryKey: productKeys.grant(productId, grantId ?? ""),
    queryFn: ({ signal }) => run(() => products.getProductGrant(productId, grantId as string, { signal })),
    refetchOnWindowFocus: false,
    ...common(o),
    enabled: (o.enabled ?? true) && !!grantId,
  });
}
