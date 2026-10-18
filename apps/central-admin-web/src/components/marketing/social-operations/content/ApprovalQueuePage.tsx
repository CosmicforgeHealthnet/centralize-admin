"use client";

import { useEffect, useState } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import EmptyState from "../../shared/EmptyState";
import PermissionGate from "../../shared/PermissionGate";

// TODO: replace with the authenticated user's identifier once auth context is wired.
const CURRENT_USER = "Idowu";

export default function ApprovalQueuePage() {
  const permissions = useSocialPermissions();
  const {
    approvalQueue, isLoadingApprovalQueue, fetchApprovalQueue,
    approvePost, rejectPost, requestPostChanges,
    settings, fetchSettings,
    actionLoading, error,
  } = useSocialOperationsStore();

  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchApprovalQueue();
    fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selfApprovalAllowed = settings?.approvalSelfReviewAllowed ?? false;

  if (isLoadingApprovalQueue) return null;

  if (approvalQueue.length === 0) {
    return <EmptyState message="Nothing pending approval" description="Submitted drafts will appear here for review." />;
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>}

      {approvalQueue.map((item) => {
        const isSelfSubmission = item.submittedBy === CURRENT_USER;
        const blockApprove = isSelfSubmission && !selfApprovalAllowed;
        const isActing = actionLoading === item.postId;
        const reason = reasonDrafts[item.postId] ?? "";

        return (
          <div key={item.postId} className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <p className="font-poppins text-[13px] font-semibold text-foreground">{item.postTitle}</p>
                <p className="font-poppins text-[11px] text-muted-foreground">
                  Submitted by {item.submittedBy} · v{item.version} · {item.ageHours}h ago · {item.targetIdentities.length} target{item.targetIdentities.length > 1 ? "s" : ""}
                </p>
              </div>
            </div>

            {blockApprove && (
              <p className="font-poppins text-[11px] text-amber-600 bg-amber-500/10 rounded-lg px-2.5 py-1.5 w-fit">
                Self-approval is disabled — a different reviewer must approve this submission.
              </p>
            )}

            <textarea
              value={reason}
              onChange={(e) => setReasonDrafts((prev) => ({ ...prev, [item.postId]: e.target.value }))}
              placeholder="Reason (required for reject or request changes)"
              rows={2}
              className="font-poppins text-[11px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground resize-none"
            />

            <div className="flex items-center gap-2 flex-wrap">
              <PermissionGate hasPermission={permissions.social_approvals === "EDIT" && !blockApprove}>
                <button
                  onClick={() => approvePost(item.postId)}
                  disabled={isActing}
                  className="font-poppins text-[11px] font-medium bg-primary text-primary-foreground px-3.5 py-1.5 rounded-lg disabled:opacity-40"
                >
                  Approve
                </button>
              </PermissionGate>
              <PermissionGate hasPermission={permissions.social_approvals === "EDIT"}>
                <button
                  onClick={() => reason.trim() && requestPostChanges(item.postId, reason)}
                  disabled={isActing || !reason.trim()}
                  className="font-poppins text-[11px] font-medium border border-border text-foreground px-3.5 py-1.5 rounded-lg disabled:opacity-40"
                >
                  Request changes
                </button>
              </PermissionGate>
              <PermissionGate hasPermission={permissions.social_approvals === "EDIT"}>
                <button
                  onClick={() => reason.trim() && rejectPost(item.postId, reason)}
                  disabled={isActing || !reason.trim()}
                  className="font-poppins text-[11px] font-medium text-red-500 disabled:opacity-40"
                >
                  Reject
                </button>
              </PermissionGate>
            </div>
          </div>
        );
      })}
    </div>
  );
}