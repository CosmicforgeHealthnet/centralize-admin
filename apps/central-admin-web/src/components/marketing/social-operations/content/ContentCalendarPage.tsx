"use client";

import { useEffect, useState } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import StatusChip from "../../shared/StatusChip";
import EmptyState from "../../shared/EmptyState";
import PermissionGate from "../../shared/PermissionGate";
import PublicationDetailPage from "./PublicationDetailPage";

export default function ContentCalendarPage() {
  const permissions = useSocialPermissions();
  const { posts, fetchPosts, publications, fetchPublications, cancelPublication, actionLoading, error } = useSocialOperationsStore();
  const [selectedPublicationId, setSelectedPublicationId] = useState<string | null>(null);

  useEffect(() => {
    fetchPosts();
    fetchPublications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (selectedPublicationId) {
    return <PublicationDetailPage publicationId={selectedPublicationId} onBack={() => setSelectedPublicationId(null)} />;
  }

  const upcoming = posts
    .filter((p) => p.scheduledFor || p.status === "SCHEDULED" || p.status === "PUBLISHING")
    .sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""));

  const relevantPublications = publications.filter((pub) => posts.some((p) => p.id === pub.postId));

  if (upcoming.length === 0 && relevantPublications.length === 0) {
    return <EmptyState message="Nothing scheduled" description="Approved posts scheduled for publishing will appear here." />;
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>}

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Upcoming</p>
        {upcoming.length === 0 ? (
          <p className="font-poppins text-[12px] text-muted-foreground">Nothing scheduled.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {upcoming.map((p) => (
              <div key={p.id} className="flex items-center justify-between border border-border rounded-lg p-2.5">
                <div className="min-w-0">
                  <p className="font-poppins text-[12px] font-medium text-foreground truncate">{p.title}</p>
                  <p className="font-poppins text-[10px] text-muted-foreground">
                    {p.scheduledFor ? new Date(p.scheduledFor).toLocaleString() : "No schedule set"} · {p.targets.length} target{p.targets.length > 1 ? "s" : ""}
                  </p>
                </div>
                <StatusChip status={p.status} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <p className="font-poppins text-[13px] font-semibold text-foreground mb-3">Publications</p>
        <div className="flex flex-col gap-2">
          {relevantPublications.map((pub) => (
            <div key={pub.id} className="flex items-center justify-between border border-border rounded-lg p-2.5">
              <button onClick={() => setSelectedPublicationId(pub.id)} className="min-w-0 text-left">
                <p className="font-poppins text-[12px] font-medium text-foreground truncate">{pub.postTitle}</p>
                <p className="font-poppins text-[10px] text-muted-foreground">
                  {pub.scheduledFor ? new Date(pub.scheduledFor).toLocaleString() : "Immediate"} · {pub.targets.length} target{pub.targets.length > 1 ? "s" : ""}
                </p>
              </button>
              <div className="flex items-center gap-2">
                <StatusChip status={pub.status} />
                {pub.status === "PENDING" && (
                  <PermissionGate hasPermission={permissions.social_publish_cancel === "EDIT"}>
                    <button
                      onClick={() => cancelPublication(pub.id)}
                      disabled={actionLoading === pub.id}
                      className="font-poppins text-[11px] text-muted-foreground disabled:opacity-40"
                    >
                      Cancel
                    </button>
                  </PermissionGate>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}