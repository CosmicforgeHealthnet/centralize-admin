"use client";

import { useEffect } from "react";
import { BarChart, Bar, XAxis, ResponsiveContainer, Tooltip } from "recharts";
import { useSupportStore } from "@/stores/support.store";

export default function UserTrafficChart() {
  const { userTraffic, fetchUserTraffic, isLoadingTraffic } = useSupportStore();

  useEffect(() => {
    fetchUserTraffic();
  }, [fetchUserTraffic]);

  return (
    <div className="bg-card rounded-lg border border-border p-3 w-full min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-0.5">
        <h2 className="text-[12px] font-bold text-foreground">User Traffic</h2>
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-muted-foreground">Last 7 days</span>
        </div>
      </div>

      {/* Big number */}
      {isLoadingTraffic || !userTraffic ? (
        <>
          <div className="w-16 h-6 bg-muted animate-pulse rounded mb-1" />
          <div className="w-20 h-3 bg-muted animate-pulse rounded mb-2" />
        </>
      ) : (
        <>
          <p className="text-[22px] font-bold text-foreground leading-tight">
            {userTraffic.avgPerDay}
          </p>
          <p className="text-[9px] text-muted-foreground mb-2">Avg users per day</p>
        </>
      )}

      {/* Bar chart */}
      {isLoadingTraffic || !userTraffic ? (
        <div className="w-full h-[120px] bg-muted animate-pulse rounded" />
      ) : (
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={userTraffic.days} barSize={10} barCategoryGap="35%">
            <XAxis
              dataKey="day"
              tick={{ fontSize: 8, fill: "var(--muted-foreground)" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: "transparent" }}
              contentStyle={{
                borderRadius: "6px",
                border: "none",
                fontSize: "10px",
                backgroundColor: "var(--primary)",
                color: "var(--primary-foreground)",
                padding: "4px 8px",
              }}
              labelStyle={{ color: "var(--primary-foreground)" }}
              itemStyle={{ color: "var(--primary-foreground)" }}
            />
            <Bar dataKey="value" fill="var(--primary)" radius={[10, 10, 10, 10]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}