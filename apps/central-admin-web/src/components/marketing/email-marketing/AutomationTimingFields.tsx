"use client";

import type { AutomationUntil, AutomationWindow } from "@/types/mail-marketing.types";
import { EmField, emInput } from "./em-ui";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ZONES = [
  { value: "recipient", label: "Recipient's time zone" },
  { value: "brand", label: "Brand default time zone" },
];

function ZoneSelect({ value, onChange, disabled, label }: { value: string | undefined; onChange: (v: string) => void; disabled: boolean; label: string }) {
  const current = value || "recipient";
  const custom = !ZONES.some((z) => z.value === current);
  return (
    <EmField label={label} hint="Recipient: contact time zone, else brand default, else UTC">
      <select value={custom ? "custom" : current} onChange={(e) => onChange(e.target.value === "custom" ? "UTC" : e.target.value)} className={emInput} disabled={disabled}>
        {ZONES.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
        <option value="custom">Fixed IANA zone…</option>
      </select>
      {custom && <input aria-label={`${label} (IANA name)`} value={current} onChange={(e) => onChange(e.target.value)} className={emInput} disabled={disabled} />}
    </EmField>
  );
}

/** Optional "wait until local time" (delay steps) and delivery window (delay + send steps). */
export default function AutomationTimingFields({
  stepId,
  until,
  window,
  allowUntil,
  disabled,
  onChange,
}: {
  stepId: string;
  until?: AutomationUntil;
  window?: AutomationWindow;
  allowUntil: boolean;
  disabled: boolean;
  onChange: (next: { until?: AutomationUntil; window?: AutomationWindow }) => void;
}) {
  const days = window?.days ?? [1, 2, 3, 4, 5, 6, 7];
  return (
    <div className="col-span-full grid grid-cols-1 gap-2 rounded border border-dashed border-border p-2 sm:grid-cols-3">
      {allowUntil && (
        <>
          <label className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
            <input type="checkbox" checked={!!until} disabled={disabled} onChange={(e) => onChange({ until: e.target.checked ? { localTime: "09:00", timezone: "recipient" } : undefined, window })} />
            Then wait until a local time
          </label>
          {until && (
            <>
              <EmField label="Local time">
                <input aria-label={`Step ${stepId} local time`} type="time" value={until.localTime} onChange={(e) => onChange({ until: { ...until, localTime: e.target.value }, window })} className={emInput} disabled={disabled} />
              </EmField>
              <ZoneSelect label="Time zone" value={until.timezone} disabled={disabled} onChange={(timezone) => onChange({ until: { ...until, timezone }, window })} />
            </>
          )}
          {!until && <span className="sm:col-span-2" />}
        </>
      )}
      <label className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
        <input type="checkbox" checked={!!window} disabled={disabled} onChange={(e) => onChange({ until, window: e.target.checked ? { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5], timezone: "recipient" } : undefined })} />
        Only deliver inside a window
      </label>
      {window && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <EmField label="From"><input aria-label={`Step ${stepId} window start`} type="time" value={window.start} onChange={(e) => onChange({ until, window: { ...window, start: e.target.value } })} className={emInput} disabled={disabled} /></EmField>
            <EmField label="To"><input aria-label={`Step ${stepId} window end`} type="time" value={window.end} onChange={(e) => onChange({ until, window: { ...window, end: e.target.value } })} className={emInput} disabled={disabled} /></EmField>
          </div>
          <ZoneSelect label="Window time zone" value={window.timezone} disabled={disabled} onChange={(timezone) => onChange({ until, window: { ...window, timezone } })} />
          <fieldset className="col-span-full flex flex-wrap gap-2 text-[11px]">
            <legend className="sr-only">Delivery days</legend>
            {DAYS.map((label, index) => {
              const day = index + 1;
              return (
                <label key={label} className="flex items-center gap-1">
                  <input type="checkbox" checked={days.includes(day)} disabled={disabled} onChange={(e) => onChange({ until, window: { ...window, days: e.target.checked ? [...days, day].sort() : days.filter((d) => d !== day) } })} />
                  {label}
                </label>
              );
            })}
          </fieldset>
          <p className="col-span-full text-[11px] text-muted-foreground">Outside the window the email waits for the next opening (once; missed windows are never caught up). Daylight-saving gaps shift forward; repeated hours use the first occurrence.</p>
        </>
      )}
    </div>
  );
}
