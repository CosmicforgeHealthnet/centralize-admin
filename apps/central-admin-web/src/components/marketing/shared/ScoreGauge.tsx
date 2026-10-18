"use client";

import type { AMIDataSufficiency } from "@/types/ai-marketing-intelligence.types";

interface ScoreGaugeProps {
  score: number | null;
  dataSufficiency: AMIDataSufficiency;
  size?: "sm" | "md";
}

function scoreColor(score: number): string {
  if (score >= 70) return "#16a34a"; // green-600
  if (score >= 40) return "#d97706"; // amber-600
  return "#dc2626"; // red-600
}

export default function ScoreGauge({ score, dataSufficiency, size = "md" }: ScoreGaugeProps) {
  const dimension = size === "sm" ? 44 : 64;
  const stroke = size === "sm" ? 4 : 5;
  const radius = (dimension - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  if (dataSufficiency === "INSUFFICIENT" || score === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-1" style={{ width: dimension }}>
        <div
          className="rounded-full border-2 border-dashed border-border flex items-center justify-center"
          style={{ width: dimension, height: dimension }}
        >
          <span className="text-[9px] font-poppins text-muted-foreground text-center leading-tight px-1">
            Below threshold
          </span>
        </div>
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, score));
  const offset = circumference - (pct / 100) * circumference;
  const color = scoreColor(pct);
  const isLowConfidence = dataSufficiency === "LIMITED";

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: dimension, height: dimension }}>
        <svg width={dimension} height={dimension} className={isLowConfidence ? "opacity-60" : ""}>
          <circle
            cx={dimension / 2}
            cy={dimension / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            className="text-muted/40"
            strokeWidth={stroke}
          />
          <circle
            cx={dimension / 2}
            cy={dimension / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${dimension / 2} ${dimension / 2})`}
            style={{ transition: "stroke-dashoffset 0.4s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`font-poppins font-semibold text-foreground ${size === "sm" ? "text-[12px]" : "text-[15px]"}`}>
            {Math.round(pct)}
          </span>
        </div>
      </div>
      {isLowConfidence && (
        <span className="text-[9px] font-poppins text-amber-600 font-medium">Low confidence</span>
      )}
    </div>
  );
}