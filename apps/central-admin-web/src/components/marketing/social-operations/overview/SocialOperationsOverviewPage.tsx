"use client";

import { useEffect } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import MetricCard from "../../shared/MetricCard";
import EmptyState from "../../shared/EmptyState";
import StatusChip from "../../shared/StatusChip";
import { Skeleton } from "@/components/ui/skeleton";

interface SocialOperationsOverviewPageProps {
  onNavigate?: (section: string) => void;
}

export default function SocialOperationsOverviewPage({ onNavigate }: SocialOperationsOverviewPageProps) {
  const permissions = useSocialPermissions();
  const {
    posts, fetchPosts, isLoadingPosts,
    approvalQueue, fetchApprovalQueue,
    publications, fetchPublications,
    conversations, fetchConversations,
    connections, fetchConnections,
  } = useSocialOperationsStore();

  useEffect(() => {
    fetchPosts();
    fetchApprovalQueue();
    fetchPublications();
    fetchConversations();
    fetchConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const scheduledToday = posts.filter((p) => p.scheduledFor?.slice(0, 10) === today).length;
  const pendingApprovalCount = approvalQueue.length;
  const failedPublications = publications.filter((p) => p.status === "FAILED_RETRYABLE" || p.status === "FAILED_PERMANENT").length;
  // Restricted conversations are never surfaced by content in overview cards — count only.
  const unreadCount = conversations.filter((c) => !c.restricted).reduce((sum, c) => sum + c.unreadCount, 0);
  const degradedConnections = connections.filter((c) => c.status !== "ACTIVE");

  if (isLoadingPosts) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[100px] rounded-xl" />)}
      </div>
    );
  }

  const hasAnyData = posts.length > 0 || publications.length > 0 || conversations.length > 0 || connections.length > 0;

  if (!hasAnyData) {
    return (
      <EmptyState
        message="Nothing to show yet"
        description="Connect a provider and create your first post to see activity here."
        actionLabel={permissions.social_connections === "EDIT" ? "Go to Accounts" : undefined}
        onAction={() => onNavigate?.("accounts")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="Scheduled today" value={scheduledToday} />
        <MetricCard label="Pending approval" value={pendingApprovalCount} />
        <MetricCard label="Failed publications" value={failedPublications} />
        <MetricCard label="Unread conversations" value={unreadCount} />
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Connection health</p>
        {connections.length === 0 ? (
          <EmptyState message="No connections configured" />
        ) : (
          <div className="flex flex-col gap-2">
            {connections.map((c) => (
              <div key={c.id} className="flex items-center justify-between">
                <span className="font-poppins text-[12px] text-foreground">{c.label}</span>
                <StatusChip status={c.status} />
              </div>
            ))}
          </div>
        )}
        {degradedConnections.length > 0 && (
          <button
            onClick={() => onNavigate?.("accounts")}
            className="font-poppins text-[11px] font-medium text-primary underline mt-3"
          >
            Resolve {degradedConnections.length} connection issue{degradedConnections.length > 1 ? "s" : ""}
          </button>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Recent activity</p>
        <div className="flex flex-col gap-2">
          {posts.slice(0, 5).map((p) => (
            <div key={p.id} className="flex items-center justify-between">
              <span className="font-poppins text-[12px] text-foreground truncate">{p.title}</span>
              <StatusChip status={p.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}