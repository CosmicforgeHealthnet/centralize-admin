"use client";

import Image from "next/image";
import { EmployeeListItem } from "@/types/hrm.types";

// ─── Card ─────────────────────────────────────────────────────────────────────

function EmployeeCard({
  emp,
  onClick,
}: {
  emp: EmployeeListItem;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-card border border-border rounded-xl p-4 flex flex-col items-center gap-2 hover:shadow-md hover:border-primary/30 transition-all duration-200 text-center w-full"
    >
      <div className="w-16 h-16 rounded-full overflow-hidden bg-muted shrink-0">
        {emp.avatarUrl ? (
          <Image
            src={emp.avatarUrl}
            alt={emp.name}
            width={64}
            height={64}
            className="object-cover w-full h-full"
          />
        ) : (
          <div className="w-full h-full bg-primary/10 flex items-center justify-center">
            <span className="text-[20px] font-poppins font-bold text-primary">
              {emp.name.charAt(0)}
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-col items-center min-w-0 w-full">
        <span className="font-poppins text-[13px] font-semibold text-foreground truncate w-full">
          {emp.name}
        </span>
        <span className="font-poppins text-[11px] font-semibold text-primary truncate w-full">
          {emp.designation || "—"}
        </span>
        <span className="font-poppins text-[11px] text-muted-foreground truncate w-full">
          {emp.department || "—"}
        </span>
      </div>
    </button>
  );
}

// ─── Skeleton Card ────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex flex-col items-center gap-2">
      <div className="w-16 h-16 rounded-full bg-muted animate-pulse" />
      <div className="h-3 w-20 bg-muted rounded animate-pulse" />
      <div className="h-3 w-16 bg-muted rounded animate-pulse" />
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function EmployeeGrid({
  employees,
  isLoading,
  onSelect,
}: {
  employees: EmployeeListItem[];
  isLoading: boolean;
  onSelect: (id: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (employees.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2">
        <p className="font-poppins text-[13px] text-muted-foreground">No employees found.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {employees.map((emp) => (
        <EmployeeCard key={emp.id} emp={emp} onClick={() => onSelect(emp.id)} />
      ))}
    </div>
  );
}