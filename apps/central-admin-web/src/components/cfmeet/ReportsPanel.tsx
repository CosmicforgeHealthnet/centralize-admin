"use client";

// CF Meet reports (GET /api/products/cfmeet/reports/{id}). Each report shows
// its definition, source, as-of time, freshness, coverage and blockers. Money
// cells are minor units in their own currency and are never summed; a value
// the source withholds is shown as withheld, never as zero.

import { useState } from "react";
import ProductDataState, { RefreshButton } from "@/components/products/ProductDataState";
import { useProductReport } from "@/lib/products.queries";
import { qualityOf } from "@/lib/products.service";
import type { Blocker } from "@/types/products.types";
import { BlockedPanel, BlockerList, StateBadge } from "./CfMeetBlocked";
import {
  CFMEET_PRODUCT_ID,
  SCOPE_DIMENSIONS,
  capabilityById,
  defaultWindow,
  isUsableState,
  missingDimensions,
  scopeQuery,
  windowProblem,
  type CfMeetCapabilities,
  type CfMeetScope,
  type ReadPurpose,
  type TimeWindow,
} from "./catalog";
import { Money, RecordTable, humanize, isRecord, type Row } from "./format";

interface ReportResult {
  report_id: string;
  title?: string;
  definition?: string;
  grain?: string;
  units?: string[];
  source?: Record<string, unknown>;
  observed_at?: string | null;
  quality?: string;
  rows?: Row[];
  blockers?: Blocker[];
  window?: { start?: string; end?: string };
  overall_status?: string;
}

const DAY_MS = 24 * 3600 * 1000;

function isCellRow(row: Row): boolean {
  return "key" in row && "unit" in row && "value" in row;
}

function CellTable({ rows, caption }: { rows: Row[]; caption: string }) {
  return (
    <div className="relative w-full overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-max border-collapse text-left text-[12px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/50 text-[11px] text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Figure</th>
            <th scope="col" className="px-3 py-2 font-medium">Value</th>
            <th scope="col" className="px-3 py-2 font-medium">Unit</th>
            <th scope="col" className="px-3 py-2 font-medium">Suppression</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const value = typeof r.value === "number" ? r.value : null;
            const currency = typeof r.currency === "string" ? r.currency : null;
            return (
              <tr key={i} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-[11px]">{String(r.key ?? "—")}</td>
                <td className="px-3 py-2">
                  {value === null ? (
                    <span className="text-muted-foreground">Withheld</span>
                  ) : r.unit === "minor_currency" ? (
                    <Money minor={value} currency={currency} />
                  ) : (
                    <span className="tabular-nums">{value.toLocaleString()}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{r.unit === "minor_currency" ? `${currency ?? "?"} (minor units)` : String(r.unit ?? "—")}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.suppression ? String(r.suppression) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReportCard({ caps, reportId, scope, purpose }: { caps: CfMeetCapabilities; reportId: string; scope: CfMeetScope; purpose: ReadPurpose }) {
  const capabilityId = `cfmeet.report.${reportId}`;
  const cap = capabilityById(caps, capabilityId);
  const summary = caps.reports?.find((r) => r.report_id === capabilityId);
  const title = cap?.description ?? humanize(reportId);
  const windowed = summary?.kind === "BRIDGE" && summary.grain === "WINDOW";
  const [range, setRange] = useState<TimeWindow>(() => {
    const w = defaultWindow();
    return { start: new Date(Date.parse(w.end) - DAY_MS).toISOString(), end: w.end };
  });
  const missing = missingDimensions(scope, SCOPE_DIMENSIONS);
  const usable = !!cap && isUsableState(cap.state);
  const report = useProductReport<ReportResult>(
    CFMEET_PRODUCT_ID,
    capabilityId,
    { ...scopeQuery(scope, SCOPE_DIMENSIONS), purpose, ...(windowed && { start: range.start, end: range.end }) },
    { enabled: usable && missing.length === 0 },
  );

  if (!cap) return <BlockedPanel title={title} state="UNAVAILABLE" blockers={[{ code: "NOT_IN_CONTRACT", detail: "The active CF Meet contract has no such report." }]} compact />;
  if (!usable) {
    return (
      <article aria-label={title} className="flex flex-col gap-2">
        <BlockedPanel title={title} state={cap.state} blockers={cap.blockers} compact />
        {summary?.definition && <p className="text-[11px] text-muted-foreground">{summary.definition}</p>}
      </article>
    );
  }
  if (missing.length) {
    return <BlockedPanel title={title} state="BLOCKED_POLICY" blockers={missing.map((d) => ({ code: `SCOPE_${d.toUpperCase()}_REQUIRED`, detail: `Your CF Meet grant has no ${d} value.` }))} compact />;
  }

  const result = report.data?.result;
  const rows = (result?.rows ?? []).filter(isRecord);
  const cells = rows.length > 0 && rows.every(isCellRow);
  return (
    <article aria-label={title} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-foreground">{result?.title ?? title}</h3>
          <p className="text-[11px] text-muted-foreground">{result?.definition ?? summary?.definition}</p>
        </div>
        <div className="flex items-center gap-2">
          <StateBadge state={cap.state} />
          <RefreshButton onClick={() => void report.refetch()} busy={report.isFetching} label={`Refresh ${title}`} />
        </div>
      </div>
      {windowed && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>Window:</span>
          {[1, 7, 31].map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => {
                const end = Date.parse(defaultWindow().end);
                const next = { start: new Date(end - days * DAY_MS).toISOString(), end: new Date(end).toISOString() };
                if (!windowProblem(next)) setRange(next);
              }}
              className="rounded border border-border px-2 py-0.5 hover:bg-muted"
            >
              Last {days === 1 ? "24 hours" : `${days} days`}
            </button>
          ))}
        </div>
      )}
      <ProductDataState
        title={title}
        loading={report.isPending}
        error={report.error}
        onRetry={() => report.refetch()}
        empty={!!result && rows.length === 0 && !(result.blockers ?? []).length}
        quality={report.data ? qualityOf(report.data) : null}
        compact
        embedded
      >
        {result && (
          <div className="flex flex-col gap-2">
            {result.overall_status && <p className="text-[12px]">Overall status: <span className="font-semibold">{result.overall_status}</span></p>}
            <BlockerList blockers={result.blockers ?? []} />
            {rows.length > 0 && (cells ? <CellTable rows={rows} caption={title} /> : <RecordTable items={rows} caption={title} />)}
            {cells && rows.some((r) => r.unit === "minor_currency") && (
              <p className="text-[11px] text-muted-foreground">Amounts stay in their own currency. They are never added together or converted.</p>
            )}
            {isRecord(result.source) && (
              <p className="text-[10px] text-muted-foreground">
                Source: {String(result.source.kind ?? "")} {String(result.source.owner ?? "")} {result.source.bridge_capability_id ? `· ${String(result.source.bridge_capability_id)}` : ""}
              </p>
            )}
          </div>
        )}
      </ProductDataState>
    </article>
  );
}

export default function ReportsPanel({ caps, reportIds, scope, purpose, title = "Reports" }: { caps: CfMeetCapabilities; reportIds: string[]; scope: CfMeetScope; purpose: ReadPurpose; title?: string }) {
  if (reportIds.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {reportIds.map((id) => (
          <ReportCard key={id} caps={caps} reportId={id} scope={scope} purpose={purpose} />
        ))}
      </div>
    </section>
  );
}
