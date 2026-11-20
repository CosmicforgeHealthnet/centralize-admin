# Product Admin frontend foundation

Shared, product-neutral building blocks for Product Admin pages in the HQ web
app (CF Meet section, generalized Verification page, approvals inbox, grants
and integration admin). Design: `docs/product-admin/cfmeet-admin-design.md` §10.

| File | What it holds |
|---|---|
| `src/types/products.types.ts` | Wire types (envelope, queries, catalog, metrics, resources, operations, grants). snake_case as on the wire. |
| `src/lib/products.service.ts` | Typed functions for every `/api/products` gateway route, `ProductApiError`, command builder. Re-exports all types. |
| `src/lib/products.queries.ts` | React Query keys and hooks, including continuation paging and the operation submit mutation. |
| `src/lib/mfa-step-up.ts` | Step-up context, `useMfaStepUp()`, `runWithStepUp()` (no JSX; used by the hooks). |
| `src/components/products/MfaStepUp.tsx` | `MfaStepUpProvider` (the dialog, built on `MfaCodeForm`), `MfaStepUpDialog`. |
| `src/components/products/FreshnessBadge.tsx` | As-of time, freshness and coverage badge. |
| `src/components/products/ProductDataState.tsx` | Loading / unavailable / empty / blocked / MFA wrapper built on `ServiceDataState`. |
| `src/components/products/OperationStatusDrawer.tsx` | Operation status + audit drawer, status badge and summary. |

Nothing here is wired into the sidebar or creates pages. Page conventions (§10):
a thin page under `app/dashboard/...`, components under `components/<product>/*`,
a sub-navigation with `?section=`, these hooks for data, and a `FreshnessBadge`
next to every figure.

## Quick start

```tsx
"use client";
import { MfaStepUpProvider } from "@/components/products/MfaStepUp";
import ProductDataState from "@/components/products/ProductDataState";
import { useProductResourcesInfinite } from "@/lib/products.queries";
import { qualityOf, type ResourceListData } from "@/lib/products.service";

type User = { id: string; display_name: string };

function Users({ market, organization }: { market: string; organization: string }) {
  const q = useProductResourcesInfinite<ResourceListData<User>>(
    "cfmeet", "cfmeet.accounts.read", "users", { market, organization, limit: 50 });
  const pages = q.data?.pages ?? [];
  const items = pages.flatMap((p) => p.result.data.items);
  return (
    <ProductDataState title="Users" loading={q.isPending} error={q.error} onRetry={() => q.refetch()}
      empty={!!q.data && items.length === 0} quality={pages[0] ? qualityOf(pages[0]) : null}>
      {/* table of items */}
      {q.hasNextPage && <button onClick={() => q.fetchNextPage()}>Load more</button>}
    </ProductDataState>
  );
}

// market/organization come from the product's effective_scope (useProducts), never hard-coded.
export default function CfMeetSection({ market, organization }: { market: string; organization: string }) {
  return <MfaStepUpProvider><Users market={market} organization={organization} /></MfaStepUpProvider>;
}
```

Capability, collection and reason ids in these examples are illustrative; take
real ids from the product's manifest/capabilities.

Mount **one** `MfaStepUpProvider` around a product section (page-level). Without
it, MFA refusals simply surface as errors (shown by `ProductDataState`, but with
no "Confirm and retry" button).

## Gateway rules the client already enforces

- Path segments are checked against the gateway patterns (`product`:
  `^[a-z][a-z0-9-]{1,31}$`, ids: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, grant ids:
  UUID) and inserted verbatim (the gateway matches the raw path; nothing is
  percent-encoded). An invalid segment throws `ProductApiError` with
  `code: "INVALID_REQUEST"`, `reason: "PATH_PARAMETER_INVALID"`, `source: "client"`.
- Query keys are typed to the gateway allowlists (`MetricQuery`,
  `ResourceListQuery`, `ResourceDetailQuery`, `ReportQuery`, `GrantListQuery`).
  Undefined/empty values are dropped. Resource and report reads require
  `market` and `organization` (PIC refuses with `SCOPE_REQUIRED` otherwise).
  Detail reads take no `limit`/`continuation`/`q`/`parent`.
- **Sensitive search.** A `q` containing `@` or 7+ digits (after removing
  spaces and `._:-`) is refused on GET (`SENSITIVE_SEARCH_REQUIRES_POST`).
  `listResources()` (and every list hook) detects this with `isContactLike()`
  and sends `POST .../search` with the query in the JSON body instead.
  `searchResources()` always uses POST.
- Grant views (`/{p}/grants`, `/{p}/grants/{uuid}`) need a recent MFA; their
  hooks step up by default.

## Errors: `ProductApiError`

Every function throws `ProductApiError` (from `toProductApiError()`), whichever
of the three error shapes the server sent: protocol envelope
(`error: { code, reason, retryable, operation_id }`), PIC
(`{ error: { code, reason }, correlation_id }`) or HQ gateway
(`{ code, retryable, message, correlationId }`).

```ts
class ProductApiError extends Error {
  status: number | null;          // HTTP status; null when no answer arrived
  code: string;                   // FORBIDDEN, UNAVAILABLE, ... or gateway code (MFA_STEP_UP_REQUIRED, INVALID_QUERY, ...)
  reason: string | null;          // most specific reason, e.g. RECENT_MFA_REQUIRED, CAPABILITY_DISABLED
  retryable: boolean;
  correlation_id: string | null;  // show it as "Ref" for support
  operation_id: string | null;    // read this operation back (never resend)
  source: "envelope" | "pic" | "gateway" | "network" | "client";
  kind: ProductErrorKind;         // see below
  envelope: ProductEnvelope<unknown> | null;
}
type ProductErrorKind = "mfa_required" | "unauthenticated" | "forbidden" | "blocked" | "not_found"
  | "invalid" | "conflict" | "rate_limited" | "unavailable" | "unknown_outcome" | "internal" | "network" | "cancelled";
```

Helpers: `toProductApiError(err)`, `isProductApiError(err)`,
`isMfaStepUpRequired(err)` (true for `RECENT_MFA_REQUIRED` and
`MFA_STEP_UP_REQUIRED`, any shape), `describeProductError(err)` (one friendly
line), `shouldRetryProductQuery(failureCount, err)` (React Query `retry`:
never on 4xx/MFA/scope/policy; ≤2 retries on network or retryable 5xx),
`MFA_REQUIRED_CODES`.

## Service functions (`@/lib/products.service`)

All take an optional last argument `{ signal?: AbortSignal }`. Envelope routes
return `ProductEnvelopeOk<T>` (`result: T`, plus `as_of`, `freshness`,
`coverage`, `correlation_id`, `product_id`, `contract_version`); an error
envelope, even with HTTP 2xx, is thrown.

```ts
listProducts(): Promise<ProductSummary[]>                                   // GET /api/products ({ success, data } route)
getProductManifest(p): Promise<ProductEnvelopeOk<ProductManifest>>
getProductCapabilities<T extends ProductCapabilities>(p): Promise<ProductEnvelopeOk<T>>
getProductDatasets(p): Promise<ProductEnvelopeOk<ProductDatasets>>
getMetricObservations(p, metricId, query?: MetricQuery): Promise<ProductEnvelopeOk<MetricResult>>
getEventsStatus(p): Promise<ProductEnvelopeOk<EventsStatus>>
listResources<TData>(p, capabilityId, collectionId, query: ResourceListQuery): Promise<ProductEnvelopeOk<ResourceRead<TData>>>
searchResources<TData>(p, capabilityId, collectionId, query: ResourceListQuery & { q: string }): Promise<ProductEnvelopeOk<ResourceRead<TData>>>
getResource<TData>(p, capabilityId, collectionId, resourceId, query: ResourceDetailQuery): Promise<ProductEnvelopeOk<ResourceRead<TData>>>
getReport<TResult>(p, reportId, query: ReportQuery): Promise<ProductEnvelopeOk<TResult>>
getOperation(p, operationId): Promise<ProductEnvelopeOk<OperationView>>       // triggers the Product Admin's readback
getOperationAudit(p, operationId): Promise<ProductEnvelopeOk<OperationAudit>>
buildOperationCommand<TParams>(input: OperationCommandInput<TParams>): OperationCommand<TParams>
submitOperation<TParams>(p, command: OperationCommand<TParams>): Promise<{ operation: OperationView; envelope }>
listProductGrants(p, query?: GrantListQuery): Promise<ProductGrantList>     // recent MFA
getProductGrant(p, grantId: uuid): Promise<ProductGrant>                    // recent MFA
isContactLike(q: string): boolean
qualityOf(envelope): DataQuality                                            // { as_of, freshness, coverage }
```

`ResourceRead<TData>` carries the product payload in `data` (lists usually
`data.items`; use `ResourceListData<TItem>`) and `continuation: string | null`
for the next page.

### Operations: submit once, settle by readback

```ts
const command = buildOperationCommand<BridgeCommandParams>({
  capability_id: "cfmeet.users.suspend",            // a COMMAND capability of the active contract
  target: { type: "cfmeet.user", id: userId, expected_version: version },
  params: { body: exactBridgeBody },                  // CF Meet: { body, approval_ref? } only
  reason_code: "POLICY_VIOLATION",                    // ^[A-Z][A-Z0-9_]{2,63}$
  case_reference: caseRef ?? null,
  scope: { market: [market], organization: [organization] },
});
```

- `command_id` is a fresh UUID v4 and is also the **operation id** for readback;
  `idempotency_key` is `hq.<command_id>`. Build the command **once per user
  intent** and keep it (e.g. in state) until it settles.
- `submitOperation()` sends it once. If the outcome is open (no answer, a
  timeout, a 5xx/broken answer after forwarding, or an envelope error after the
  Product Admin was reached), it throws `kind: "unknown_outcome"`,
  `retryable: false`, `operation_id: command.command_id`. Show
  `OperationStatusDrawer` for that id. A successful submit may also return
  `status: "UNKNOWN_OUTCOME"`; handle it the same way.
- Definite refusals (4xx, PIC pre-forward errors, gateway codes such as
  `PRODUCT_INTEGRATION_DISABLED`) are thrown with their normal kind.
- Note: `src/lib/api.ts` retries any request once after a silent token refresh
  on 401. That is safe here (401 is refused before forwarding, and the same
  command_id/idempotency_key make a duplicate a replay), but no other resend
  exists.

## Hooks (`@/lib/products.queries`)

`ProductQueryOptions = { enabled?, staleTime?, refetchInterval?, stepUp? }`.
`stepUp: true` asks for an MFA step-up and retries once when the read is
refused for a missing recent MFA (needs `MfaStepUpProvider`). Every read uses
`retry: shouldRetryProductQuery`. Undefined options keep the QueryClient
defaults.

```ts
productKeys                                   // all keys; invalidate productKeys.product(p) to refresh one product
useProducts(options?)
useProductManifest(p, options?)
useProductCapabilities<T>(p, options?)
useProductDatasets(p, options?)
useMetricObservations(p, metricId, query?, options?)
useEventsStatus(p, options?)
useProductResources<TData>(p, capabilityId, collectionId, query, options?)            // one page
useProductResourcesInfinite<TData>(p, capabilityId, collectionId, queryWithoutContinuation, options?)
  // data.pages: ProductEnvelopeOk<ResourceRead<TData>>[]; fetchNextPage() follows result.continuation
useProductResource<TData>(p, capabilityId, collectionId, resourceId, query, options?)
useProductReport<TResult>(p, reportId, query, options?)
useOperation(p, operationId | null, options?: ProductQueryOptions & { pollUnsettledMs?: number })
useOperationAudit(p, operationId | null, options?)
useSubmitProductOperation(p, { stepUp? = true, onSuccess?, onError? })
  // useMutation<OperationSubmitResult, ProductApiError, OperationCommand>; retry: false.
  // mutate(command) with a prebuilt command. MFA refusal -> step-up -> the SAME command once more.
  // On success the operation query is seeded; on unknown_outcome it is invalidated.
useProductGrants(p, query?, options?)          // stepUp defaults to true; no refetch on focus
useProductGrantsInfinite(p, queryWithoutCursor?, options?)   // follows next_cursor
useProductGrant(p, grantId | null, options?)
UNSETTLED_OPERATION_STATUSES                   // ["RECORDED", "DISPATCHING", "UNKNOWN_OUTCOME"]
```

Resource reads may hold personal data; their cache entries are dropped 5
minutes after last use (`gcTime`). Contact-like `q` values never enter a URL,
but they are part of the in-memory query key.

## MFA step-up (`@/components/products/MfaStepUp`)

```tsx
<MfaStepUpProvider title?: string description?: string>{children}</MfaStepUpProvider>
useMfaStepUp(): {
  available: boolean;                                // a provider is mounted
  requestStepUp(): Promise<void>;                    // opens the shared dialog; rejects with MFA_STEP_UP_CANCELLED on cancel
  withStepUp<T>(fn: () => Promise<T>): Promise<T>;   // run, step up on MFA refusal, run once more
}
runWithStepUp(fn, requestStepUp)                     // the same logic without React
<MfaStepUpDialog open title? description? onVerified onCancel />   // controlled dialog, rarely needed
stepUpFailureMessage(err): string
```

The dialog uses `MfaCodeForm` (authenticator code or recovery code) and calls
`POST /api/auth/mfa/step-up` (`accountSecurity.stepUp`). Concurrent callers
share one dialog. The step-up window on the server is 5 minutes.

## Display pieces

### `FreshnessBadge` (default export of `FreshnessBadge.tsx`)

```tsx
<FreshnessBadge quality={envelope /* or qualityOf(envelope) */} compact? asOfLabel?="As of" className? />
observationQuality(observation): DataQuality   // metric observations use source_observed_at
formatAsOf(iso): string | null
```

Shows "As of <time>" (or "No source observation"), Fresh/Stale/Freshness
unknown, and Complete/Partial/No/Unknown coverage.

### `ProductDataState` (default export of `ProductDataState.tsx`)

```tsx
<ProductDataState
  title="Users"                 // short data name
  loading={q.isPending}
  error={q.error}               // any thrown value
  empty={...}                   // succeeded but nothing returned
  emptyMessage?
  onRetry={() => q.refetch()}
  quality={envelope ? qualityOf(envelope) : null}   // renders FreshnessBadge above children
  loadingFallback? compact? embedded?
>{children}</ProductDataState>
productErrorView(err): "mfa" | "blocked" | "unavailable"
<ErrorReference error={productApiError} />          // "Reason: CODE / REASON · Ref: correlation_id"
<RefreshButton onClick busy? label? />
```

- `unavailable` (outage, contract mismatch, network, 5xx, invalid, not found)
  uses `ServiceDataState` with a retry button. Never zero, never empty.
- `empty` uses `ServiceDataState empty`.
- `blocked` (forbidden, switched off `DISABLED`, `BLOCKED_POLICY`,
  unauthenticated) shows a lock panel with the reason code.
- `mfa` shows "Confirm and retry", which runs the step-up and then `onRetry`
  once.

### `OperationStatusDrawer` (default export of `OperationStatusDrawer.tsx`)

```tsx
<OperationStatusDrawer productId="cfmeet" operationId={id} open={open} onOpenChange={setOpen}
  title?="Operation status" pollUnsettledMs?={30000} />
<OperationStatusBadge status={op.status} />
<OperationSummary operation={op} checkedAt?={dataUpdatedAt} />
<OperationAuditList records={audit.records} />
operationStatusLabel(status), operationStatusExplanation(status), readbackExplanation(readback)
```

Shows status (including `UNKNOWN_OUTCOME`: "settled by readback, never
resent"), `outcome_known`, `executed`, reason, source status/version, readback
state with an explanation, timestamps, approval reference, and the audit trail.
The refresh button reads back again ("Read back now" while unsettled); while
open and unsettled it re-reads every `pollUnsettledMs`. There is no resend
action by design.
