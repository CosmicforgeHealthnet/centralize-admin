"use client";

import React, { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonLine({ w = "w-24", h = "h-3" }: { w?: string; h?: string }) {
  return <div className={`${w} ${h} bg-muted rounded animate-pulse`} />;
}

function FieldSkeleton() {
  return (
    <div className="flex flex-col gap-1">
      <SkeletonLine w="w-16" h="h-2" />
      <SkeletonLine w="w-24" h="h-3" />
    </div>
  );
}

// ── Field components ──────────────────────────────────────────────────────────

function FieldItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[11px] font-poppins text-muted-foreground leading-tight truncate">
        {label}
      </span>
      <span className="text-[12px] font-poppins font-semibold text-foreground leading-tight break-words">
        {value || "—"}
      </span>
    </div>
  );
}

function MaskedField({
  label,
  value,
  visible,
}: {
  label: string;
  value: string | null | undefined;
  visible: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[11px] font-poppins text-muted-foreground leading-tight truncate">
        {visible ? label : "••••"}
      </span>
      <span className="text-[12px] font-poppins font-semibold text-foreground leading-tight tracking-widest">
        {visible ? (value || "—") : "••••"}
      </span>
    </div>
  );
}

// ── Sensitive section wrapper ─────────────────────────────────────────────────

function SensitiveSection({
  title,
  children,
}: {
  title: string;
  children: (visible: boolean) => React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="bg-card border border-border rounded-[12px] p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[14px] font-poppins font-semibold text-foreground">
          {title}
        </span>
        <button
          onClick={() => setVisible((v) => !v)}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          {visible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
      </div>
      {children(visible)}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EmploymentDetailsTab() {
  const { profile, isLoading, fetchProfile } = useProfileStore();

  useEffect(() => {
    if (!profile) fetchProfile();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || !profile) {
    return (
      <div className="flex flex-col gap-3 flex-1 min-w-0 overflow-hidden">
        <div className="bg-card border border-border rounded-[12px] p-4">
          <SkeletonLine w="w-36" h="h-4" />
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-5 gap-3">
            {[...Array(5)].map((_, i) => <FieldSkeleton key={i} />)}
          </div>
          <div className="mt-3">
            <FieldSkeleton />
          </div>
        </div>
      </div>
    );
  }

  const employmentDate = profile.createdAt
    ? new Date(profile.createdAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <div className="flex flex-col gap-3 flex-1 min-w-0 overflow-hidden">

      {/* Employment Info */}
      <div className="bg-card border border-border rounded-[12px] p-4">
        <div className="mb-3">
          <span className="text-[14px] font-poppins font-semibold text-foreground">
            Employment Info
          </span>
        </div>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-5 gap-3">
            <FieldItem label="Position:" value={profile.position} />
            <FieldItem label="Department:" value={profile.department} />

            {/* ✅ FIXED FIELDS */}
            <FieldItem label="Employment Type:" value={profile.employmentType} />
            <FieldItem label="Employment Category:" value={profile.employmentCategory} />
            <FieldItem label="Employment Date:" value={employmentDate} />
          </div>

          {/* ✅ FIXED */}
          <FieldItem label="Location:" value={profile.location} />
        </div>
      </div>

      {/* Sensitive Sections */}
      <SensitiveSection title="Equity Info">
        {(visible) => (
          <MaskedField label="Total Equity" value={profile.equity ?? null} visible={visible} />
        )}
      </SensitiveSection>

      <SensitiveSection title="Salary Info">
        {(visible) => (
          <MaskedField label="Total Salary" value={profile.salary ?? null} visible={visible} />
        )}
      </SensitiveSection>

      <SensitiveSection title="Bonus Info">
        {(visible) => (
          <MaskedField label="Total Bonus" value={profile.bonus ?? null} visible={visible} />
        )}
      </SensitiveSection>

    </div>
  );
}