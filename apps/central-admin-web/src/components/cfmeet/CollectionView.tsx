"use client";

// One CF Meet collection, read through the product gateway:
//  - list / nested: continuation-paged list ("Load more"), search box for
//    SCOPED_SEARCH (contact-like terms go by POST automatically, in
//    listResources), time window for SCOPED_WINDOW (bounded like the Product
//    Admin: at most 31 days, not in the future);
//  - single: one object (SCOPED shape, no paging);
//  - detail: one resource by id.
// Blocked or disabled collections are never requested; they show their reason.

import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import ProductDataState, { RefreshButton } from "@/components/products/ProductDataState";
import { useProductResource, useProductResourcesInfinite } from "@/lib/products.queries";
import { qualityOf } from "@/lib/products.service";
import type { ResourceListQuery } from "@/types/products.types";
import { BlockedPanel } from "./CfMeetBlocked";
import {
  CFMEET_PRODUCT_ID,
  SEARCH_PATTERN,
  defaultWindow,
  missingDimensions,
  scopeQuery,
  windowProblem,
  type CfMeetScope,
  type CollectionModel,
  type ReadPurpose,
  type TimeWindow,
} from "./catalog";
import { RecordFields, RecordTable, isRecord, type Row } from "./format";

const PAGE_SIZE = 50;

function MissingScope({ title, missing }: { title: string; missing: string[] }) {
  return (
    <BlockedPanel
      title={title}
      state="BLOCKED_POLICY"
      blockers={missing.map((d) => ({ code: `SCOPE_${d.toUpperCase()}_REQUIRED`, detail: `Your CF Meet grant has no ${d} value, and CF Meet reads need one exact ${d}.` }))}
      compact
    />
  );
}

// datetime-local works in the browser's time zone; the wire uses UTC ISO.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function WindowPicker({ value, onApply, idPrefix }: { value: TimeWindow; onApply: (w: TimeWindow) => void; idPrefix: string }) {
  const [draft, setDraft] = useState({ start: toLocalInput(value.start), end: toLocalInput(value.end) });
  const candidate = { start: fromLocalInput(draft.start), end: fromLocalInput(draft.end) };
  const problem = windowProblem(candidate);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!problem) onApply(candidate);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label="Time window">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${idPrefix}-start`} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">From</label>
        <input id={`${idPrefix}-start`} type="datetime-local" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} className="rounded-md border border-border bg-card px-2 py-1 text-[12px]" />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${idPrefix}-end`} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">To</label>
        <input id={`${idPrefix}-end`} type="datetime-local" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} className="rounded-md border border-border bg-card px-2 py-1 text-[12px]" />
      </div>
      <button type="submit" disabled={!!problem} className="rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted disabled:opacity-50">Apply window</button>
      <p className="w-full text-[11px] text-muted-foreground">
        {problem ? <span role="alert" className="text-amber-700 dark:text-amber-400">{problem}</span> : "Your local time. At most 31 days; CF Meet Admin refuses longer or future windows."}
      </p>
    </form>
  );
}

function SearchBox({ value, onSearch, idPrefix }: { value: string; onSearch: (q: string) => void; idPrefix: string }) {
  const [draft, setDraft] = useState(value);
  const trimmed = draft.trim();
  const invalid = trimmed !== "" && !SEARCH_PATTERN.test(trimmed);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!invalid) onSearch(trimmed);
  };
  return (
    <form role="search" onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div className="flex min-w-[200px] flex-1 flex-col gap-1">
        <label htmlFor={`${idPrefix}-q`} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Search</label>
        <input
          id={`${idPrefix}-q`}
          type="search"
          maxLength={128}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Name, slug or id"
          className="rounded-md border border-border bg-card px-2 py-1.5 text-[12px]"
        />
      </div>
      <button type="submit" disabled={invalid} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted disabled:opacity-50">
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        Search
      </button>
      {invalid && <p role="alert" className="w-full text-[11px] text-amber-700 dark:text-amber-400">Use letters, digits, spaces and . _ @ : - only (up to 128).</p>}
    </form>
  );
}

export interface CollectionViewProps {
  collection: CollectionModel;
  scope: CfMeetScope;
  purpose: ReadPurpose;
  /** Parent resource id of a nested list. */
  parent?: string;
  /** Opens a row (detail drawer). */
  onOpenRow?: (row: Row) => void;
  title?: string;
}

/** A list, nested list or single-object collection. */
export function CollectionList({ collection, scope, purpose, parent, onOpenRow, title }: CollectionViewProps) {
  const name = title ?? collection.label;
  const idPrefix = `cfmeet-${collection.id.replaceAll(".", "-")}`;
  const [q, setQ] = useState("");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(() => defaultWindow());
  const missing = missingDimensions(scope, collection.scopeDimensions);
  const paged = collection.role !== "single";
  const query: Omit<ResourceListQuery, "continuation"> = {
    ...scopeQuery(scope, collection.scopeDimensions),
    purpose,
    ...(paged && { limit: PAGE_SIZE }),
    ...(collection.shape === "SCOPED_SEARCH" && q && { q }),
    ...(collection.shape === "SCOPED_WINDOW" && { start: timeWindow.start, end: timeWindow.end }),
    ...(collection.role === "nested" && parent && { parent }),
  };
  const enabled = collection.usable && missing.length === 0 && (collection.role !== "nested" || !!parent);
  const list = useProductResourcesInfinite<unknown>(CFMEET_PRODUCT_ID, collection.readCapabilityId, collection.id, query, { enabled });

  if (!collection.usable) return <BlockedPanel title={name} state={collection.state} blockers={collection.blockers} compact />;
  if (missing.length) return <MissingScope title={name} missing={missing} />;

  const pages = list.data?.pages ?? [];
  const first = pages[0];
  const firstData = first?.result.data;
  const hasItems = isRecord(firstData) && Array.isArray(firstData.items);
  const items: Row[] = hasItems ? pages.flatMap((p) => (isRecord(p.result.data) && Array.isArray(p.result.data.items) ? (p.result.data.items as Row[]) : [])) : [];
  const empty = !!first && (hasItems ? items.length === 0 : firstData === null || firstData === undefined);

  return (
    <section aria-label={name} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-1 flex-col gap-3">
          {collection.shape === "SCOPED_SEARCH" && <SearchBox value={q} onSearch={setQ} idPrefix={idPrefix} />}
          {collection.shape === "SCOPED_WINDOW" && <WindowPicker value={timeWindow} onApply={setTimeWindow} idPrefix={idPrefix} />}
        </div>
        <RefreshButton onClick={() => void list.refetch()} busy={list.isFetching} label={`Refresh ${name}`} />
      </div>
      <ProductDataState
        title={name}
        loading={list.isPending}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={empty}
        emptyMessage={q ? "No records match this search in the selected scope." : undefined}
        quality={first ? qualityOf(first) : null}
        compact
      >
        {hasItems ? (
          <div className="flex flex-col gap-2">
            <RecordTable items={items} onSelect={onOpenRow ? (row) => onOpenRow(row) : undefined} caption={name} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>
                {items.length.toLocaleString()} record{items.length === 1 ? "" : "s"} loaded{list.hasNextPage ? "; more available" : "; end of list"}
              </span>
              {list.hasNextPage && (
                <button
                  type="button"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                  className="rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {list.isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
            {list.isFetchNextPageError && <p role="alert" className="text-[11px] text-amber-700 dark:text-amber-400">The next page could not be loaded. Try again.</p>}
          </div>
        ) : isRecord(firstData) ? (
          <RecordFields record={firstData} />
        ) : null}
      </ProductDataState>
    </section>
  );
}

/** One resource by id (detail collection). */
export function CollectionDetail({ collection, scope, purpose, resourceId, title }: { collection: CollectionModel; scope: CfMeetScope; purpose: ReadPurpose; resourceId: string; title?: string }) {
  const name = title ?? collection.label;
  const missing = missingDimensions(scope, collection.scopeDimensions);
  const detail = useProductResource<unknown>(
    CFMEET_PRODUCT_ID,
    collection.readCapabilityId,
    collection.id,
    resourceId,
    { ...scopeQuery(scope, collection.scopeDimensions), purpose },
    { enabled: collection.usable && missing.length === 0 },
  );
  if (!collection.usable) return <BlockedPanel title={name} state={collection.state} blockers={collection.blockers} compact />;
  if (missing.length) return <MissingScope title={name} missing={missing} />;
  const data = detail.data?.result.data;
  return (
    <ProductDataState
      title={name}
      loading={detail.isPending}
      error={detail.error}
      onRetry={() => detail.refetch()}
      empty={!!detail.data && (data === null || data === undefined)}
      quality={detail.data ? qualityOf(detail.data) : null}
      compact
      embedded
    >
      {isRecord(data) ? (
        <RecordFields record={data} />
      ) : Array.isArray(data) ? (
        <RecordTable items={data as Row[]} caption={name} />
      ) : null}
    </ProductDataState>
  );
}
