"use client";

import { useEffect } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import ProviderBadge, { BadgeProvider } from "../../shared/ProviderBadge";
import CapabilityPill, { CapabilityState } from "../../shared/CapabilityPill";
import NativeOnlyCard from "../../shared/NativeOnlyCard";
import StatusChip from "../../shared/StatusChip";
import PermissionGate from "../../shared/PermissionGate";
import EmptyState from "../../shared/EmptyState";

interface IdentityDetailPageProps {
  identityId: string;
  onBack: () => void;
}

const CAPABILITY_LABELS: Record<string, string> = {
  publishText: "Publish text", publishImage: "Publish image", publishVideo: "Publish video",
  readComments: "Read comments", replyComments: "Reply to comments",
  readMessages: "Read messages", sendMessages: "Send messages", deletePost: "Delete post",
};

export default function IdentityDetailPage({ identityId, onBack }: IdentityDetailPageProps) {
  const permissions = useSocialPermissions();
  const {
    identities, refreshIdentityCapabilities, syncIdentityContent, contentItems, fetchContentItems,
    actionLoading,
  } = useSocialOperationsStore();

  useEffect(() => {
    fetchContentItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const identity = identities.find((i) => i.id === identityId);
  if (!identity) {
    return <EmptyState message="Identity not found" actionLabel="Back to connections" onAction={onBack} />;
  }

  const recentContent = contentItems.filter((c) => c.identityId === identityId);
  const isRefreshing = actionLoading === identityId;
  const isSyncing = actionLoading === identityId; // shares the same key intentionally — both are single-identity actions

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="font-poppins text-[11px] text-muted-foreground w-fit">← Back to connections</button>

      <div className="bg-card rounded-xl border border-border p-4 flex items-center justify-between flex-wrap gap-3">
        <ProviderBadge provider={identity.provider as BadgeProvider} subtitle={`@${identity.username}`} />
        <div className="flex items-center gap-2">
          <StatusChip status={identity.status} />
          <span className="font-poppins text-[11px] text-muted-foreground">{identity.identityType.replace(/_/g, " ")}</span>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="font-poppins text-[13px] font-semibold text-foreground">Capabilities</p>
          <PermissionGate hasPermission={permissions.social_connections === "EDIT"}>
            <button
              onClick={() => refreshIdentityCapabilities(identity.id)}
              disabled={isRefreshing}
              className="font-poppins text-[11px] font-medium text-primary disabled:opacity-40"
            >
              {isRefreshing ? "Refreshing…" : "Refresh capabilities"}
            </button>
          </PermissionGate>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {Object.entries(identity.capabilities).map(([key, state]) => (
            <div key={key} className="flex items-center justify-between border border-border rounded-lg px-3 py-2">
              <span className="font-poppins text-[12px] text-foreground">{CAPABILITY_LABELS[key] ?? key}</span>
              <CapabilityPill state={state as CapabilityState} />
            </div>
          ))}
        </div>
        {identity.lastDiscoveryAt && (
          <p className="font-poppins text-[10px] text-muted-foreground mt-2">
            Last discovered {new Date(identity.lastDiscoveryAt).toLocaleString()}
          </p>
        )}

        {Object.entries(identity.capabilities)
          .filter(([, state]) => state === "NATIVE_ONLY")
          .map(([key]) => (
            <div key={key} className="mt-2">
              <NativeOnlyCard
                actionLabel={CAPABILITY_LABELS[key] ?? key}
                reason="This provider doesn't expose this action through the approved API for this account type."
              />
            </div>
          ))}
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="font-poppins text-[13px] font-semibold text-foreground">Recent content</p>
          <PermissionGate hasPermission={permissions.social_operations === "EDIT"}>
            <button
              onClick={() => syncIdentityContent(identity.id)}
              disabled={isSyncing}
              className="font-poppins text-[11px] font-medium text-primary disabled:opacity-40"
            >
              {isSyncing ? "Syncing…" : "Sync content"}
            </button>
          </PermissionGate>
        </div>
        {recentContent.length === 0 ? (
          <EmptyState message="No synced content yet" description="Run a content sync to pull recent posts from this identity." />
        ) : (
          <div className="flex flex-col gap-2">
            {recentContent.map((item) => (
              <div key={item.id} className="flex items-center justify-between border border-border rounded-lg p-2.5">
                <div className="flex flex-col min-w-0">
                  <span className="font-poppins text-[12px] text-foreground truncate">{item.text ?? item.type}</span>
                  <span className="font-poppins text-[10px] text-muted-foreground">
                    {item.source === "PROVIDER_IMPORTED" ? "Imported from provider" : "Published from CosmicForge"}
                  </span>
                </div>
                {item.providerUrl && (
                  <a href={item.providerUrl} target="_blank" rel="noopener noreferrer" className="font-poppins text-[11px] text-primary underline shrink-0">
                    View
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}