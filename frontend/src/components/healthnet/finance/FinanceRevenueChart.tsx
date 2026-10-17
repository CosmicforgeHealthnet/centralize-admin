"use client";

import { useEffect, useState } from "react";
import { Download, ChevronDown } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useHealthnetStore } from "@/stores/healthnet.store";

// ─── Types ────────────────────────────────────────────────────────────────────

type RevenueType = "sales" | "subscriptions";

// Backend defaults to current UTC year when no year param is sent.
// We mirror that: show the last 3 years but send `undefined` for the
// current year so the backend picks it up correctly regardless of
// any clock skew between client and server.
const CURRENT_YEAR = new Date().getUTCFullYear();
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2].map(String);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// The revenue values are USD amounts (usdAmount on the transactions table).
function formatUsd(value: number) {
  if (value === 0) return "$0";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

const CustomTooltip = ({
  active,
  payload,
  label,
  mode,
}: {
  active?: boolean;
  payload?: { value: number; name: string; color: string }[];
  label?: string;
  mode: RevenueType;
}) => {
  if (!active || !payload?.length) return null;
  const secondaryLabel = mode === "subscriptions" ? "Subscriptions" : "Sales";
  return (
    <div className="bg-card border border-border rounded-[10px] shadow-[0_4px_20px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.3)] px-3.5 py-2.5 text-[12px] font-poppins">
      <p className="font-semibold text-foreground mb-1.5">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground capitalize">
            {p.name === "appointments" ? "Appointments" : secondaryLabel}:
          </span>
          {/* Show real USD amount, not a raw number */}
          <span className="font-semibold text-foreground">{formatUsd(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

// ─── Skeleton data (12 zero-height bars while loading) ────────────────────────

const SKELETON_DATA = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
  .map((month) => ({ month, appointments: 0, secondary: 0 }));

// ─── Main Component ───────────────────────────────────────────────────────────

interface FinanceRevenueChartProps {
  mode?: RevenueType;
}

export default function FinanceRevenueChart({ mode = "sales" }: FinanceRevenueChartProps) {
  const [selectedYear, setSelectedYear] = useState(YEARS[0]);
  const [yearOpen, setYearOpen] = useState(false);

  const {
    financeRevenueTracking,
    financeRevenueTrackingLoading,
    fetchFinanceRevenueTracking,
  } = useHealthnetStore();

  useEffect(() => {
    // For the current year pass `undefined` so the backend uses its own
    // UTC clock (avoids client/server year mismatch at year boundaries).
    // For past years pass the explicit number.
    const yearParam =
      selectedYear === YEARS[0] ? undefined : Number(selectedYear);

    fetchFinanceRevenueTracking({
      ...(yearParam !== undefined && { year: yearParam }),
      type: mode,
      format: "json",
    });
  }, [selectedYear, mode, fetchFinanceRevenueTracking]);

  // The backend returns months with `appointments` + `sales` OR `subscriptions`
  // depending on the `type` param — map to a consistent `secondary` key.
  const chartData = (financeRevenueTracking?.data?.months ?? []).map((m) => ({
    month: m.month,
    appointments: m.appointments ?? 0,
    secondary: (mode === "subscriptions" ? m.subscriptions : m.sales) ?? 0,
  }));

  // A "no data" state means the API returned 0 months, not all-zero months.
  // All-zero is valid (no transactions yet this year) — we still render the chart.
  const hasNoMonths = !financeRevenueTrackingLoading && chartData.length === 0;

  const secondaryLabel = mode === "subscriptions" ? "Subscriptions" : "Sales";

  // Check whether all values are zero so we can show a subtle hint
  const allZero =
    !financeRevenueTrackingLoading &&
    chartData.length > 0 &&
    chartData.every((d) => d.appointments === 0 && d.secondary === 0);

  return (
    <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5 sm:p-6">
      {/* Header */}
      <div className="flex flex-col xs:flex-row xs:items-start justify-between gap-3 mb-5">
        <div>
          <h2 className="text-[17px] font-poppins font-bold text-foreground">Revenue Tracking</h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">Revenue Performance and Report</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Legend */}
          <div className="flex items-center gap-3 mr-1">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-primary" />
              <span className="text-[11px] font-poppins text-muted-foreground">Appointments</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-emerald-500" />
              <span className="text-[11px] font-poppins text-muted-foreground">{secondaryLabel}</span>
            </div>
          </div>

          {/* Year picker */}
          <div className="relative">
            <button
              onClick={() => setYearOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-[8px] text-[12px] font-poppins text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_4px_rgba(0,0,0,0.2)] hover:border-primary/40 transition-colors"
            >
              {selectedYear}
              <ChevronDown
                className={`w-3 h-3 text-muted-foreground transition-transform ${yearOpen ? "rotate-180" : ""}`}
              />
            </button>
            {yearOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setYearOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-[8px] shadow-[0_4px_16px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] overflow-hidden min-w-[80px]">
                  {YEARS.map((y) => (
                    <button
                      key={y}
                      onClick={() => { setSelectedYear(y); setYearOpen(false); }}
                      className={`w-full text-left px-3.5 py-2 text-[12px] font-poppins transition-colors ${
                        selectedYear === y
                          ? "bg-primary/8 text-primary font-semibold"
                          : "text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {y}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Download — triggers CSV export from the backend */}
          <button
            onClick={() =>
              fetchFinanceRevenueTracking({
                ...(selectedYear !== YEARS[0] && { year: Number(selectedYear) }),
                type: mode,
                format: "csv",
              })
            }
            className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-[8px] text-[12px] font-poppins text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_4px_rgba(0,0,0,0.2)] hover:border-primary/40 transition-colors"
          >
            <Download className="w-3 h-3 text-muted-foreground" />
            <span className="hidden xs:inline">Download Report</span>
          </button>
        </div>
      </div>

      {/* Chart */}
      <div className="w-full h-[260px] sm:h-[300px] relative">
        {financeRevenueTrackingLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/70 z-10 rounded-[8px]">
            <div className="flex flex-col items-center gap-2">
              <div className="w-5 h-5 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
              <span className="text-[11px] font-poppins text-muted-foreground">Loading data…</span>
            </div>
          </div>
        )}

        {hasNoMonths ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[13px] font-poppins text-muted-foreground">
              No revenue data available for {selectedYear}.
            </p>
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={financeRevenueTrackingLoading ? SKELETON_DATA : chartData}
                barCategoryGap="30%"
                barGap={3}
                margin={{ top: 4, right: 0, left: -4, bottom: 0 }}
              >
                <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.5} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11, fontFamily: "Poppins, sans-serif", fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fontFamily: "Poppins, sans-serif", fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatUsd}
                  width={52}
                />
                <Tooltip
                  content={<CustomTooltip mode={mode} />}
                  cursor={{ fill: "var(--muted)" }}
                />
                <Bar
                  dataKey="appointments"
                  name="appointments"
                  fill={financeRevenueTrackingLoading ? "var(--muted)" : "#272EA7"}
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="secondary"
                  name="secondary"
                  fill={financeRevenueTrackingLoading ? "var(--muted)" : "#22C55E"}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>

            {/* Subtle hint when bars are all zero (valid state — no transactions yet) */}
            {allZero && (
              <p className="absolute bottom-0 left-0 right-0 text-center text-[11px] font-poppins text-muted-foreground/50 pb-1">
                No transactions recorded for {selectedYear} yet
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}