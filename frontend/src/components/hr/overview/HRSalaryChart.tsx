"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

// ─── Mock Data ────────────────────────────────────────────────────────────────

const DATA = [
  { department: "Product Design", salary: 4000 },
  { department: "Marketing",      salary: 4000 },
  { department: "Audit",          salary: 4000 },
  { department: "Engineering",    salary: 5200 },
  { department: "HR",             salary: 3400 },
  { department: "Finance",        salary: 4600 },
];

const PERIOD_OPTIONS = ["Last Month", "Last Quarter", "This Year"];

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
      <p className="font-poppins text-[11px] text-muted-foreground mb-0.5">{label}</p>
      <p className="font-poppins text-[13px] font-semibold text-foreground">
        ${payload[0].value.toLocaleString()}
      </p>
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function HRSalaryChart() {
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">
            Salary Statistics
          </h3>
        </div>
        <select className="text-[11px] font-poppins text-muted-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer">
          {PERIOD_OPTIONS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={DATA} barSize={36} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
          <XAxis
            dataKey="department"
            tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `$${v / 1000}k`}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(39,46,167,0.04)" }} />
          <Bar dataKey="salary" radius={[6, 6, 0, 0]}>
            {DATA.map((_, i) => (
              <Cell
                key={i}
                fill={i === 0 ? "#272EA7" : "rgba(39,46,167,0.18)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}