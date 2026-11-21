"use client";

// Generic rendering of CF Meet records. Columns come from the record's own
// scalar fields; times, money (minor units with currency, never summed) and
// ids get their own formatting. Field names CF Meet Admin must never relay
// are dropped here too (defence in depth; the Product Admin already refuses
// such a response).

import type { ReactNode } from "react";
import { formatAsOf } from "@/components/products/FreshnessBadge";
import { cn } from "@/lib/utils";

/** Same list as services/cfmeet-admin src/modules/reads.js FORBIDDEN_FIELD. */
export const FORBIDDEN_FIELD =
  /^(?:nin|bvn|ssn|national_id|passport(?:_number)?|document_number|id_number|password|passcode|pin|otp|secret|token|api_key|private_key|phone|phone_number|msisdn|email|email_address|latitude|longitude|lat|lng|lon|gps|coordinates|location_trail|account_number|iban|card_number|pan|cvv|message_body|body_text|raw_payload)$/i;

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CURRENCY = /^[A-Z]{3}$/;

export type Row = Record<string, unknown>;

export const isRecord = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** "lifecycle_status" -> "Lifecycle status". */
export function humanize(key: string): string {
  const text = key.replaceAll("_", " ").replaceAll("-", " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Keys that may be shown (forbidden personal fields removed). */
export function visibleKeys(row: Row): string[] {
  return Object.keys(row).filter((k) => !FORBIDDEN_FIELD.test(k));
}

/** Table columns: the first item's scalar fields (money currency columns fold into their amount). */
export function columnsOf(items: Row[]): string[] {
  const first = items.find(isRecord);
  if (!first) return [];
  const keys = visibleKeys(first).filter((k) => isScalar(first[k]));
  // The currency travels inside the formatted amount, so its own column is dropped.
  const currencyKeys = new Set(keys.filter(isMinorKey).flatMap((m) => [currencyKeyFor(m), "currency"]));
  return keys.filter((k) => !currencyKeys.has(k));
}

const isIdKey = (key: string) => key === "id" || key.endsWith("_id") || key === "slug" || key.endsWith("_ref");
const isTimeKey = (key: string) => key.endsWith("_at") || key === "date" || key.endsWith("_date") || key === "as_of";
const isMinorKey = (key: string) => key.endsWith("_minor") || key === "minor_units" || key.endsWith("_minor_units");
function currencyKeyFor(key: string): string {
  const base = key.replace(/_minor(_units)?$/, "").replace(/^minor_units$/, "");
  return base ? `${base}_currency` : "currency";
}

/** Minor units -> major using the currency's own decimals; the raw minor value stays in the title. */
export function formatMinor(minor: number, currency: string): string {
  try {
    const nf = new Intl.NumberFormat(undefined, { style: "currency", currency });
    const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
    return nf.format(minor / 10 ** digits);
  } catch {
    return `${minor.toLocaleString()} ${currency} (minor units)`;
  }
}

function Time({ iso }: { iso: string }) {
  const text = formatAsOf(iso);
  return text ? <time dateTime={iso} title={iso}>{text}</time> : <span>{iso}</span>;
}

export function Money({ minor, currency }: { minor: number; currency: string | null | undefined }) {
  if (!currency || !CURRENCY.test(currency)) return <span title="Minor units; currency not stated" className="tabular-nums">{minor.toLocaleString()} (minor units, no currency)</span>;
  return <span title={`${minor} minor units ${currency}`} className="tabular-nums">{formatMinor(minor, currency)}</span>;
}

/** One value of a record, formatted by its key and type. */
export function CellValue({ field, value, row }: { field: string; value: unknown; row?: Row }): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (isMinorKey(field)) {
      const currency = row ? (row[currencyKeyFor(field)] ?? row.currency) : null;
      return <Money minor={value} currency={typeof currency === "string" ? currency : null} />;
    }
    return <span className="tabular-nums">{value.toLocaleString()}</span>;
  }
  if (typeof value === "string") {
    if ((isTimeKey(field) || ISO_DATE_TIME.test(value)) && ISO_DATE_TIME.test(value)) return <Time iso={value} />;
    if (isIdKey(field)) return <span className="break-all font-mono text-[11px]">{value}</span>;
    return <span className="break-words">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return <span className="break-words">{value.map((v) => String(v ?? "—")).join(", ") || "—"}</span>;
    return <span className="text-muted-foreground">{value.length} item{value.length === 1 ? "" : "s"}</span>;
  }
  return <span className="text-muted-foreground">Object</span>;
}

/** Key/value view of one record; nested objects are shown recursively (depth-limited). */
export function RecordFields({ record, depth = 0, className }: { record: Row; depth?: number; className?: string }) {
  const keys = visibleKeys(record);
  if (keys.length === 0) return <p className="text-[12px] text-muted-foreground">No fields.</p>;
  return (
    <dl className={cn("grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2", className)}>
      {keys.map((key) => {
        const value = record[key];
        const nested = isRecord(value) && depth < 3;
        const nestedList = Array.isArray(value) && value.some(isRecord) && depth < 3;
        return (
          <div key={key} className={cn("min-w-0", (nested || nestedList) && "sm:col-span-2")}>
            <dt className="text-[11px] text-muted-foreground">{humanize(key)}</dt>
            <dd className="text-[13px] text-foreground">
              {nested ? (
                <RecordFields record={value as Row} depth={depth + 1} className="mt-1 rounded-md border border-border p-2" />
              ) : nestedList ? (
                <ol className="mt-1 flex flex-col gap-2">
                  {(value as unknown[]).slice(0, 50).map((v, i) => (
                    <li key={i} className="rounded-md border border-border p-2">
                      {isRecord(v) ? <RecordFields record={v} depth={depth + 1} /> : <CellValue field={key} value={v} />}
                    </li>
                  ))}
                </ol>
              ) : (
                <CellValue field={key} value={value} row={record} />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Generic table of records. Rows are clickable when `onSelect` is given. */
export function RecordTable({ items, onSelect, caption }: { items: Row[]; onSelect?: (row: Row, index: number) => void; caption: string }) {
  const columns = columnsOf(items);
  if (columns.length === 0) {
    return (
      <ol className="flex flex-col gap-2">
        {items.map((item, i) => (
          <li key={i} className="rounded-md border border-border p-2">{isRecord(item) ? <RecordFields record={item} /> : <CellValue field="value" value={item} />}</li>
        ))}
      </ol>
    );
  }
  return (
    <div className="relative w-full overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-max border-collapse text-left text-[12px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/50 text-[11px] text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{humanize(c)}</th>
            ))}
            {onSelect && <th scope="col" className="px-3 py-2"><span className="sr-only">Open</span></th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => {
            const row = isRecord(item) ? item : { value: item };
            return (
              <tr key={i} className="border-t border-border align-top hover:bg-muted/30">
                {columns.map((c) => (
                  <td key={c} className="max-w-[280px] px-3 py-2 text-foreground"><CellValue field={c} value={row[c]} row={row} /></td>
                ))}
                {onSelect && (
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => onSelect(row, i)} className="rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Open
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
