"use client";

import { useEffect, useState } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import StatusChip from "../../shared/StatusChip";
import EmptyState from "../../shared/EmptyState";
import PermissionGate from "../../shared/PermissionGate";
import type { SOEscalationClassification } from "@/types/social-operations.types";

const CLASSIFICATIONS: SOEscalationClassification[] = [
  "MEDICAL_EMERGENCY", "SELF_HARM_RISK", "CLINICAL_ADVICE_REQUEST", "PRESCRIPTION_REQUEST",
  "PROTECTED_HEALTH_INFORMATION", "PRIVACY_INCIDENT", "PATIENT_COMPLAINT", "LEGAL_THREAT",
  "MEDICAL_MISINFORMATION", "GENERAL_INQUIRY",
];

export default function CommentsQueuePage() {
  const permissions = useSocialPermissions();
  const { comments, isLoadingComments, fetchComments, hideComment, escalateComment, actionLoading, error } = useSocialOperationsStore();
  const [confirmingHideId, setConfirmingHideId] = useState<string | null>(null);
  const [escalatingId, setEscalatingId] = useState<string | null>(null);
  const [classification, setClassification] = useState<SOEscalationClassification>("GENERAL_INQUIRY");

  useEffect(() => {
    fetchComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoadingComments) return null;
  if (comments.length === 0) {
    return <EmptyState message="No comments yet" description="Comments on your published and imported content will appear here." />;
  }

  const handleHide = async (id: string) => {
    await hideComment(id);
    setConfirmingHideId(null);
  };

  const handleEscalate = async (id: string) => {
    await escalateComment(id, classification);
    setEscalatingId(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>}

      {comments.map((comment) => (
        <div key={comment.id} className="bg-card rounded-xl border border-border p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-poppins text-[12px] font-medium text-foreground">{comment.author}</span>
            <StatusChip status={comment.status} />
          </div>
          <p className="font-poppins text-[12px] text-muted-foreground">{comment.text}</p>

          {confirmingHideId === comment.id ? (
            <div className="flex items-center gap-2">
              <span className="font-poppins text-[11px] text-foreground">Hide this comment? It can be unhidden if the provider supports it.</span>
              <button onClick={() => handleHide(comment.id)} disabled={actionLoading === comment.id} className="font-poppins text-[11px] font-medium text-red-500">Confirm</button>
              <button onClick={() => setConfirmingHideId(null)} className="font-poppins text-[11px] text-muted-foreground">Cancel</button>
            </div>
          ) : escalatingId === comment.id ? (
            <div className="flex flex-col gap-2">
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value as SOEscalationClassification)}
                className="font-poppins text-[11px] bg-background border border-border rounded-lg px-2 py-1 text-foreground w-fit"
              >
                {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
              </select>
              <div className="flex items-center gap-2">
                <button onClick={() => handleEscalate(comment.id)} disabled={actionLoading === comment.id} className="font-poppins text-[11px] font-medium text-amber-600">Confirm escalation</button>
                <button onClick={() => setEscalatingId(null)} className="font-poppins text-[11px] text-muted-foreground">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <PermissionGate hasPermission={permissions.social_moderation_hide === "EDIT"}>
                <button onClick={() => setConfirmingHideId(comment.id)} className="font-poppins text-[11px] font-medium text-muted-foreground">Hide</button>
              </PermissionGate>
              <PermissionGate hasPermission={permissions.social_moderation_escalate === "EDIT"}>
                <button onClick={() => setEscalatingId(comment.id)} className="font-poppins text-[11px] font-medium text-amber-600">Escalate</button>
              </PermissionGate>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}