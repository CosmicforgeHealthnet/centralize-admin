"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { grantsService } from "@/lib/hrm.service";
import { readHttpErrorMessage } from "@/lib/error-messages";
import { ACCOUNT_ROLE_LABELS, formatEnumLabel, Module } from "@/types/hrm.types";
import PermissionChip from "./PermissionChip";

// Effective permissions on the account page: department defaults (from
// department + role, automatic) and the additional Module Permissions.
export default function EffectiveAccessPanel({ accountId, refreshKey = 0 }: { accountId: string; refreshKey?: number }) {
  const query = useQuery({
    queryKey: ["hr", "effective-access", accountId, refreshKey],
    queryFn: () => grantsService.getEffectiveAccess(accountId),
    retry: false,
  });
  const { data, isLoading: loading } = query;
  const error = query.error ? readHttpErrorMessage(query.error) || "Failed to load effective access" : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" />
      </div>
    );
  }
  if (error) return <p className="font-poppins text-[11px] text-red-500">{error}</p>;
  if (!data) return null;

  const brands = data.emailMarketing ?? [];
  return (
    <div className="flex flex-col gap-2" data-testid="effective-access">
      <p className="font-poppins text-[11px] text-muted-foreground">
        {data.department
          ? `${ACCOUNT_ROLE_LABELS[data.role]} in ${formatEnumLabel(data.department)}`
          : "No department assigned"}
        {!data.active && ` · ${formatEnumLabel(data.status)}: no access until the account is active`}
      </p>

      <span className="font-poppins text-[11px] font-semibold text-foreground">Inherited from department</span>
      {data.inherited.length === 0 ? (
        <p className="font-poppins text-[11px] text-muted-foreground">None.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {data.inherited.map((grant) => (
            <PermissionChip key={`${grant.module}:${grant.section}`} module={grant.module as Module} section={grant.section} mode={grant.mode} size="sm" />
          ))}
        </div>
      )}

      <span className="font-poppins text-[11px] font-semibold text-foreground mt-1">Email Marketing brands</span>
      {brands.length === 0 ? (
        <p className="font-poppins text-[11px] text-muted-foreground">
          No brand assigned. Add an Email Marketing brand under Module Permissions.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {brands.map((brand) => (
            <li key={brand.slug} className="font-poppins text-[11px] text-muted-foreground">
              {brand.name}: {[brand.canView && "view", brand.canAuthor && "author", brand.canApprove && "approve"].filter(Boolean).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
