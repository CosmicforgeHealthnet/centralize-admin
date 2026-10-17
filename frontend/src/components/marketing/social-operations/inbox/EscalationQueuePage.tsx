"use client";

import { useEffect } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import StatusChip from "../../shared/StatusChip";
import SensitiveContentBanner from "../../shared/SensitiveContentBanner";
import EmptyState from "../../shared/EmptyState";
import { AlertOctagon } from "lucide-react";

const URGENT_CLASSIFICATIONS = ["MEDICAL_EMERGENCY", "SELF_HARM_RISK"];

export default function EscalationQueuePage() {
  const permissions = useSocialPermissions();
  const { escalations, isLoadingEscalations, fetchEscalations, error } = useSocialOperationsStore();

  useEffect(() => {
    fetchEscalations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // This queue is restricted regardless of the parent Inbox VIEW grant — a separate
  // classification-level permission is required to even see that an item exists.
  if (permissions.social_moderation_restricted !== "VIEW") {
    return (
      <div className="bg-card rounded-xl border border-border p-6 text-center">
        <p className="font-poppins text-[12px] text-muted-foreground">
          You don&apos;t have access to restricted escalations.
        </p>
      </div>
    );
  }

  if (isLoadingEscalations) return null;
  if (escalations.length === 0) {
    return <EmptyState message="No open escalations" />;
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>}

      {escalations.map((esc) => {
        const isUrgent = URGENT_CLASSIFICATIONS.includes(esc.classification);
        return (
          <div
            key={esc.id}
            className={`rounded-xl border p-4 flex flex-col gap-2 ${isUrgent ? "border-red-500/40 bg-red-500/5" : "border-border bg-card"}`}
          >
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                {isUrgent && <AlertOctagon className="w-4 h-4 text-red-500" />}
                <span className="font-poppins text-[12px] font-semibold text-foreground">
                  {esc.classification.replace(/_/g, " ")}
                </span>
              </div>
              <StatusChip status={esc.status} />
            </div>

            {esc.restrictedVisibility && (
              <SensitiveContentBanner canReveal classification={esc.classification} />
            )}

            <p className="font-poppins text-[10px] text-muted-foreground">
              Detected {new Date(esc.detectedAt).toLocaleString()}
              {esc.assignee ? ` · Assigned to ${esc.assignee}` : " · Unassigned"}
              {esc.taskId ? ` · Task ${esc.taskId}` : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}