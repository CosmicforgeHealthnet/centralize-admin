"use client";

import { useEffect } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import ProviderBadge, { BadgeProvider } from "../../shared/ProviderBadge";
import StatusChip from "../../shared/StatusChip";
import EmptyState from "../../shared/EmptyState";
import PermissionGate from "../../shared/PermissionGate";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProviderContentPage() {
  const permissions = useSocialPermissions();
  const { contentItems, isLoadingContentItems, fetchContentItems, syncIdentityContent, actionLoading, error } = useSocialOperationsStore();

  useEffect(() => {
    fetchContentItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoadingContentItems) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[160px] rounded-xl" />)}
      </div>
    );
  }

  if (contentItems.length === 0) {
    return <EmptyState message="No content yet" description="Sync a connected identity to pull in provider content." />;
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {contentItems.map((item) => (
          <div key={item.id} className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <ProviderBadge provider={item.provider as BadgeProvider} subtitle={item.identityLabel} size="sm" />
              <StatusChip status={item.source === "PROVIDER_IMPORTED" ? "READ_ONLY" : "PUBLISHED"} tone={item.source === "PROVIDER_IMPORTED" ? "neutral" : "success"} label={item.source === "PROVIDER_IMPORTED" ? "Imported" : "Published"} />
            </div>
            <p className="font-poppins text-[12px] text-foreground line-clamp-2">{item.text ?? item.type}</p>
            <div className="grid grid-cols-3 gap-1 font-poppins text-[10px] text-muted-foreground">
              {item.metrics.impressions !== undefined && <span>Impressions: {item.metrics.impressions.toLocaleString()}</span>}
              {item.metrics.likes !== undefined && <span>Likes: {item.metrics.likes.toLocaleString()}</span>}
              <span>Comments: {item.commentCount}</span>
            </div>
            {item.providerUrl && (
              <a href={item.providerUrl} target="_blank" rel="noopener noreferrer" className="font-poppins text-[11px] text-primary underline w-fit">
                View on provider
              </a>
            )}
            <PermissionGate hasPermission={permissions.social_operations === "EDIT"}>
              <button
                onClick={() => syncIdentityContent(item.identityId)}
                disabled={actionLoading === item.identityId}
                className="font-poppins text-[11px] font-medium text-muted-foreground w-fit"
              >
                {actionLoading === item.identityId ? "Syncing…" : "Re-sync"}
              </button>
            </PermissionGate>
          </div>
        ))}
      </div>
    </div>
  );
}