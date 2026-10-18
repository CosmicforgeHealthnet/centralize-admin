"use client";

import { BarChart, Bar, XAxis, ResponsiveContainer, Tooltip, LabelList } from "recharts";

const agentData = [
  { day: "Today", value: 400 },
  { day: "Yesterday", value: 93 },
  { day: "2 Days", value: 150 },
  { day: "3 Days", value: 50 },
  { day: "4 Days", value: 409 },
  { day: "5 Days", value: 106 },
  { day: "6 Days", value: 987 },
  { day: "7 Days", value: 300 },
];

const agents = [
  { name: "Grace Famoriyo", id: "Agent #123456", total: "2,495", change: "10%" },
  { name: "Grace Famoriyo", id: "Agent #123456", total: "2,495", change: "10%" },
  { name: "Grace Famoriyo", id: "Agent #123456", total: "2,495", change: "10%" },
  { name: "Grace Famoriyo", id: "Agent #123456", total: "2,495", change: "10%" },
];

function AgentCard({ agent }: { agent: typeof agents[0] }) {
  return (
    <div className="bg-card rounded-lg border border-border p-3 min-w-0">
      {/* Agent info */}
      <div className="flex items-center gap-2 mb-2">
        <img
          src="https://i.pravatar.cc/32?img=5"
          alt={agent.name}
          className="w-7 h-7 rounded-full object-cover shrink-0"
        />
        <div>
          <p className="text-[11px] font-semibold text-foreground leading-tight">
            {agent.name}
          </p>
          <p className="text-[9px] text-muted-foreground leading-tight">
            {agent.id}
          </p>
        </div>
      </div>

      {/* Chart + total side by side */}
      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <ResponsiveContainer width="100%" height={100}>
            <BarChart
              data={agentData}
              barSize={12}
              barCategoryGap="20%"
              margin={{ top: 16, right: 0, left: 0, bottom: 0 }}
            >
              <XAxis
                dataKey="day"
                tick={{ fontSize: 7, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <Tooltip
                cursor={{ fill: "transparent" }}
                contentStyle={{
                  borderRadius: "6px",
                  border: "none",
                  fontSize: "10px",
                  backgroundColor: "var(--primary)",
                  color: "var(--primary-foreground)",
                  padding: "3px 6px",
                }}
                labelStyle={{ color: "var(--primary-foreground)" }}
                itemStyle={{ color: "var(--primary-foreground)" }}
              />
              <Bar dataKey="value" fill="var(--primary)" radius={[3, 3, 0, 0]}>
                <LabelList
                  dataKey="value"
                  position="top"
                  style={{ fontSize: 7, fill: "var(--muted-foreground)", fontFamily: "Poppins" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Total */}
        <div className="shrink-0 text-right pb-5">
          <p className="text-[18px] font-bold text-foreground leading-tight">
            {agent.total}
          </p>
          <p className="text-[9px] text-muted-foreground">This Week</p>
          <p className="text-[9px] font-semibold text-success">▲ {agent.change}</p>
        </div>
      </div>
    </div>
  );
}

export default function OpenTicketsPerAgent() {
  return (
    <div>
      <h2 className="text-[14px] font-bold text-foreground mb-3">
        Open Tickets per Agents
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {agents.map((agent, i) => (
          <AgentCard key={i} agent={agent} />
        ))}
      </div>
    </div>
  );
}