"use client";

// React Query hooks over lib/product-integrations.service.ts.
//
//  - Every admin route needs a recent MFA step-up (gateway rule), reads
//    included, so reads step up by default (needs an MfaStepUpProvider).
//  - Writes are never retried by React Query. A write refused for a missing
//    recent MFA is a definite refusal made before anything ran, so after the
//    step-up the SAME request is sent once more (runWithStepUp). Any other
//    failure is shown with its reason; an open outcome is never resent.
//  - After a write (success or open outcome) the affected registry/grant
//    queries are invalidated so the screen shows what the server holds.

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMfaStepUp } from "@/lib/mfa-step-up";
import { productKeys, type ProductQueryOptions } from "@/lib/products.queries";
import { shouldRetryProductQuery } from "@/lib/products.service";
import * as svc from "@/lib/product-integrations.service";
import type { AdminApiError } from "@/lib/product-integrations.service";

export const integrationKeys = {
  all: ["product-integrations"] as const,
  list: () => ["product-integrations", "list"] as const,
  detail: (id: string) => ["product-integrations", "item", id] as const,
  monitoring: (id: string) => ["product-integrations", "item", id, "monitoring"] as const,
};

const readDefaults = (o: ProductQueryOptions) => ({
  ...(o.enabled !== undefined && { enabled: o.enabled }),
  ...(o.staleTime !== undefined && { staleTime: o.staleTime }),
  ...(o.refetchInterval !== undefined && { refetchInterval: o.refetchInterval }),
  retry: shouldRetryProductQuery,
  refetchOnWindowFocus: false,
});

function useRunner(stepUp: boolean) {
  const { withStepUp } = useMfaStepUp();
  return <T,>(fn: () => Promise<T>) => (stepUp ? withStepUp(fn) : fn());
}

/** All registrations (integration.read). */
export function useIntegrations(options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp ?? true);
  return useQuery<svc.IntegrationRegistration[], AdminApiError>({
    queryKey: integrationKeys.list(),
    queryFn: ({ signal }) => run(() => svc.listIntegrations({ signal })),
    ...readDefaults(options),
  });
}

export function useIntegration(id: string | null | undefined, options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp ?? true);
  return useQuery<svc.IntegrationDetail, AdminApiError>({
    queryKey: integrationKeys.detail(id ?? ""),
    queryFn: ({ signal }) => run(() => svc.getIntegration(id as string, { signal })),
    ...readDefaults(options),
    enabled: (options.enabled ?? true) && !!id,
  });
}

export function useIntegrationMonitoring(id: string | null | undefined, options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp ?? true);
  return useQuery<svc.IntegrationMonitoring, AdminApiError>({
    queryKey: integrationKeys.monitoring(id ?? ""),
    queryFn: ({ signal }) => run(() => svc.getIntegrationMonitoring(id as string, { signal })),
    ...readDefaults(options),
    enabled: (options.enabled ?? true) && !!id,
  });
}

/** Monitoring for several registrations at once (registry list: contract revision and sync state). */
export function useIntegrationMonitorings(ids: string[], options: ProductQueryOptions = {}) {
  const run = useRunner(options.stepUp ?? true);
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: integrationKeys.monitoring(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => run(() => svc.getIntegrationMonitoring(id, { signal })),
      ...readDefaults(options),
      staleTime: options.staleTime ?? 60_000,
    })),
  });
}

export interface AdminMutationOptions<TResult, TVars> {
  /** Extra query keys to invalidate after the write (success or open outcome). */
  invalidate?: (vars: TVars, result: TResult | undefined) => readonly (readonly unknown[])[];
  onSuccess?: (result: TResult, vars: TVars) => void;
  onError?: (error: AdminApiError, vars: TVars) => void;
}

/**
 * A governed admin write: one request, MFA step-up and one resend of the same
 * request only when it was refused for a missing recent MFA, never retried
 * otherwise. Errors are AdminApiError (reason, detail, outcomeUnknown).
 */
export function useAdminMutation<TResult, TVars>(
  key: string,
  fn: (vars: TVars) => Promise<TResult>,
  options: AdminMutationOptions<TResult, TVars> = {},
) {
  const queryClient = useQueryClient();
  const { withStepUp } = useMfaStepUp();
  const refresh = (vars: TVars, result: TResult | undefined) => {
    for (const k of options.invalidate?.(vars, result) ?? []) void queryClient.invalidateQueries({ queryKey: k });
  };
  return useMutation<TResult, AdminApiError, TVars>({
    mutationKey: ["product-integrations", "write", key],
    retry: false,
    mutationFn: async (vars) => {
      try {
        return await withStepUp(() => fn(vars));
      } catch (err) {
        throw svc.toAdminApiError(err, { write: true });
      }
    },
    onSuccess: (result, vars) => {
      refresh(vars, result);
      options.onSuccess?.(result, vars);
    },
    onError: (error, vars) => {
      if (error.outcomeUnknown) refresh(vars, undefined);
      options.onError?.(error, vars);
    },
  });
}

/** Keys touched by any write on one registration. */
export const registrationKeys = (id: string) => [integrationKeys.list(), integrationKeys.detail(id), integrationKeys.monitoring(id)] as const;

/** Keys touched by a grant write for one product. */
export const grantKeys = (productId: string) => [productKeys.grants(productId)] as const;
