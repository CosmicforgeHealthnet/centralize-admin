"use client";

import { useEffect, useState } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import ProviderBadge, { BadgeProvider } from "../../shared/ProviderBadge";
import StatusChip from "../../shared/StatusChip";
import DataTable, { DataTableColumn } from "../../shared/DataTable";
import PermissionGate from "../../shared/PermissionGate";
import IdentityDetailPage from "./IdentityDetailPage";
import type { SOConnection } from "@/types/social-operations.types";

export default function SocialConnectionsPage() {
  const permissions = useSocialPermissions();
  const {
    connections, isLoadingConnections, fetchConnections,
    testConnection, reauthorizeConnection, disableConnection, enableConnection,
    discoverIdentities, identities, fetchIdentities, actionLoading,
    error, clearError,
  } = useSocialOperationsStore();

  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections();
    fetchIdentities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) {
      const t = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(t);
    }
  }, [error, clearError]);

  if (selectedIdentityId) {
    return <IdentityDetailPage identityId={selectedIdentityId} onBack={() => setSelectedIdentityId(null)} />;
  }

  const columns: DataTableColumn<SOConnection>[] = [
    { key: "provider", header: "Provider", render: (c) => <ProviderBadge provider={c.provider as BadgeProvider} subtitle={c.label} /> },
    { key: "status", header: "Status", render: (c) => <StatusChip status={c.status} /> },
    { key: "scopes", header: "Scopes", render: (c) => (
        <span className="text-[11px] text-muted-foreground">{c.scopes.length > 0 ? c.scopes.join(", ") : "—"}</span>
      ) },
    { key: "expiresAt", header: "Expires", render: (c) => (c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "—") },
    { key: "webhook", header: "Webhook", render: (c) => (
        <StatusChip status={c.webhookHealthy ? "ACTIVE" : "ERROR"} label={c.webhookHealthy ? "Healthy" : "Degraded"} />
      ) },
    { key: "identityCount", header: "Identities", render: (c) => c.identityCount },
    { key: "actions", header: "Actions", render: (c) => {
        const isActing = actionLoading === c.id;
        const isTesting = actionLoading === `test-${c.id}`;
        return (
          <div className="flex items-center gap-2 flex-wrap">
            <PermissionGate hasPermission={permissions.social_connections === "EDIT"}>
              <button onClick={() => testConnection(c.id)} disabled={isTesting} className="font-poppins text-[11px] font-medium text-primary disabled:opacity-40">
                {isTesting ? "Testing…" : "Test"}
              </button>
            </PermissionGate>
            {c.status === "REAUTHORIZATION_REQUIRED" && (
              <PermissionGate hasPermission={permissions.social_connections === "EDIT"}>
                <button onClick={() => reauthorizeConnection(c.id)} disabled={isActing} className="font-poppins text-[11px] font-medium text-amber-600 disabled:opacity-40">
                  Reconnect
                </button>
              </PermissionGate>
            )}
            <PermissionGate hasPermission={permissions.social_connections === "EDIT"}>
              <button onClick={() => discoverIdentities(c.id)} disabled={isActing} className="font-poppins text-[11px] font-medium text-foreground disabled:opacity-40">
                {isActing ? "Discovering…" : "Discover identities"}
              </button>
            </PermissionGate>
            <PermissionGate hasPermission={permissions.social_connections === "EDIT"}>
              {c.status === "ACTIVE" ? (
                <button onClick={() => disableConnection(c.id)} className="font-poppins text-[11px] text-muted-foreground">Disable</button>
              ) : (
                <button onClick={() => enableConnection(c.id)} disabled={!c.hasRequiredCredentials} className="font-poppins text-[11px] text-primary disabled:opacity-40">Enable</button>
              )}
            </PermissionGate>
          </div>
        );
      } },
  ];

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>
      )}

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Provider connections</p>
        <DataTable columns={columns} rows={connections} rowKey={(c) => c.id} isLoading={isLoadingConnections} emptyLabel="No organic provider connections configured yet" />
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Publishing identities</p>
        {identities.length === 0 ? (
          <p className="font-poppins text-[12px] text-muted-foreground">Run "Discover identities" on a connection to populate this list.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {identities.map((identity) => (
              <button
                key={identity.id}
                onClick={() => setSelectedIdentityId(identity.id)}
                className="flex items-center justify-between border border-border rounded-lg p-2.5 hover:bg-muted/40 transition-colors text-left"
              >
                <ProviderBadge provider={identity.provider as BadgeProvider} subtitle={identity.username} size="sm" />
                <StatusChip status={identity.status} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}