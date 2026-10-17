"use client";

import { useEffect } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import MetricCard from "../../shared/MetricCard";
import EmptyState from "../../shared/EmptyState";

export default function OrganicAnalyticsPage() {
  const {
    contentItems, fetchContentItems,
    publications, fetchPublications,
    conversations, fetchConversations,
  } = useSocialOperationsStore();

  useEffect(() => {
    fetchContentItems();
    fetchPublications();
    fetchConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (contentItems.length === 0 && publications.length === 0) {
    return <EmptyState message="No analytics data yet" description="Publish and sync content to see performance here." />;
  }

  const totalImpressions = contentItems.reduce((sum, c) => sum + (c.metrics.impressions ?? 0), 0);
  const totalReach = contentItems.reduce((sum, c) => sum + (c.metrics.reach ?? 0), 0);
  const totalLikes = contentItems.reduce((sum, c) => sum + (c.metrics.likes ?? 0), 0);
  const totalComments = contentItems.reduce((sum, c) => sum + c.commentCount, 0);

  const successfulPublications = publications.filter((p) => p.status === "PUBLISHED").length;
  const successRate = publications.length > 0 ? Math.round((successfulPublications / publications.length) * 100) : null;

  const unreadTotal = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
  const resolvedCount = conversations.filter((c) => c.status === "RESOLVED").length;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="Impressions" value={totalImpressions} />
        <MetricCard label="Reach" value={totalReach} />
        <MetricCard label="Likes" value={totalLikes} />
        <MetricCard label="Comments" value={totalComments} />
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Publishing reliability</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <MetricCard label="Publish success rate" value={successRate !== null ? `${successRate}%` : null} unavailableReason="No publications yet" />
          <MetricCard label="Total publications" value={publications.length} />
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Community</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <MetricCard label="Unread conversations" value={unreadTotal} />
          <MetricCard label="Resolved conversations" value={resolvedCount} />
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Top content</p>
        <div className="flex flex-col gap-2">
          {[...contentItems]
            .sort((a, b) => (b.metrics.impressions ?? 0) - (a.metrics.impressions ?? 0))
            .slice(0, 5)
            .map((item) => (
              <div key={item.id} className="flex items-center justify-between border border-border rounded-lg p-2.5">
                <span className="font-poppins text-[12px] text-foreground truncate">{item.text ?? item.type}</span>
                <span className="font-poppins text-[11px] text-muted-foreground">
                  {(item.metrics.impressions ?? 0).toLocaleString()} impressions
                </span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}