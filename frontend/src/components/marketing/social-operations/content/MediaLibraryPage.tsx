"use client";

import { useEffect } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import StatusChip from "../../shared/StatusChip";
import EmptyState from "../../shared/EmptyState";
import PermissionGate from "../../shared/PermissionGate";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageIcon, Video, UploadCloud } from "lucide-react";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MediaLibraryPage() {
  const permissions = useSocialPermissions();
  const { media, isLoadingMedia, fetchMedia, deleteMedia, actionLoading, error } = useSocialOperationsStore();

  useEffect(() => {
    fetchMedia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>}

      <PermissionGate hasPermission={permissions.social_content === "EDIT"}>
        <div className="border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center gap-2 text-center">
          <UploadCloud className="w-5 h-5 text-muted-foreground" />
          <p className="font-poppins text-[12px] text-muted-foreground">Drag assets here or click to upload</p>
        </div>
      </PermissionGate>

      {isLoadingMedia ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[140px] rounded-xl" />)}
        </div>
      ) : media.length === 0 ? (
        <EmptyState message="No media uploaded yet" />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {media.map((m) => {
            const isVideo = m.mimeType.startsWith("video/");
            const isBlockedByUsage = m.usageCount > 0;
            return (
              <div key={m.id} className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2">
                <div className="h-[80px] rounded-lg bg-muted flex items-center justify-center">
                  {isVideo ? <Video className="w-5 h-5 text-muted-foreground" /> : <ImageIcon className="w-5 h-5 text-muted-foreground" />}
                </div>
                <span className="font-poppins text-[11px] font-medium text-foreground truncate">{m.fileName}</span>
                <div className="flex items-center justify-between">
                  <StatusChip status={m.status} />
                  <span className="font-poppins text-[10px] text-muted-foreground">{formatBytes(m.sizeBytes)}</span>
                </div>
                {m.durationSeconds && (
                  <span className="font-poppins text-[10px] text-muted-foreground">{m.durationSeconds}s · {m.aspectRatio}</span>
                )}
                {isBlockedByUsage ? (
                  <span className="font-poppins text-[10px] text-muted-foreground" title="Used in a post — remove references first">
                    Used in {m.usageCount} post{m.usageCount > 1 ? "s" : ""}
                  </span>
                ) : (
                  <PermissionGate hasPermission={permissions.social_content === "EDIT"}>
                    <button
                      onClick={() => deleteMedia(m.id)}
                      disabled={actionLoading === m.id}
                      className="font-poppins text-[10px] font-medium text-red-500 disabled:opacity-40 text-left"
                    >
                      Delete
                    </button>
                  </PermissionGate>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}