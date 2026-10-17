"use client";

import { useEffect, useState } from "react";
import { X, AlertCircle } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import type { AMIRecommendationDetail } from "@/types/ai-marketing-intelligence.types";

interface ConvertToTaskModalProps {
  recommendation: AMIRecommendationDetail;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ConvertToTaskModal({ recommendation, onClose, onSuccess }: ConvertToTaskModalProps) {
  const { eligibleAssignees, loadEligibleAssignees, isConvertingToTask, convertRecommendation, error, clearError } =
    useAIMarketingIntelligenceStore();

  const [assigneeId, setAssigneeId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [needsAssignee, setNeedsAssignee] = useState(false);

  useEffect(() => {
    loadEligibleAssignees();
    return () => clearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async () => {
    const payload: { assigneeAdminUserId?: string; dueDate?: string } = {};
    if (assigneeId) payload.assigneeAdminUserId = assigneeId;
    if (dueDate) payload.dueDate = new Date(dueDate).toISOString();

    const result = await convertRecommendation(recommendation.id, payload);
    if (result.success) {
      onSuccess();
    } else if (result.needsAssignee) {
      setNeedsAssignee(true);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative w-full sm:max-w-lg bg-card rounded-t-[16px] sm:rounded-[14px] border border-border shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-border sticky top-0 bg-card">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Convert to Task</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>

        <div className="p-4 sm:p-5 flex flex-col gap-4">
          {/* Description preview */}
          <div className="rounded-[10px] border border-border bg-muted/30 p-3.5 flex flex-col gap-1.5">
            <p className="font-poppins text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Task description preview
            </p>
            <p className="font-poppins text-[12px] text-foreground">{recommendation.reasoning}</p>
            <p className="font-poppins text-[11px] text-muted-foreground">
              Suggested action: {recommendation.suggestedAction.action}
            </p>
            <p className="font-poppins text-[11px] text-muted-foreground">
              {recommendation.currencyCode ?? "No currency"} · {recommendation.analysisWindow.from} → {recommendation.analysisWindow.to}
            </p>
          </div>

          {/* Assignee */}
          <div className="flex flex-col gap-1.5">
            <label className="font-poppins text-[12px] font-medium text-foreground">
              Assignee <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <select
              value={assigneeId}
              onChange={(e) => { setAssigneeId(e.target.value); setNeedsAssignee(false); }}
              className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">Leave blank — backend will resolve fallback</option>
              {eligibleAssignees.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          {/* Due date */}
          <div className="flex flex-col gap-1.5">
            <label className="font-poppins text-[12px] font-medium text-foreground">
              Due date <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <input
              type="datetime-local"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {needsAssignee && (
            <div className="flex items-start gap-2 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2.5">
              <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" strokeWidth={2} />
              <p className="font-poppins text-[11px] text-amber-800">
                No eligible Marketing administrator is available. Select an assignee above, or configure a default assignee in Settings & Controls.
              </p>
            </div>
          )}

          {error && !needsAssignee && (
            <div className="flex items-center gap-2 rounded-[8px] border border-red-200 bg-red-50 px-3 py-2.5">
              <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" strokeWidth={2} />
              <p className="font-poppins text-[11px] text-red-700">{error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 sm:px-5 py-3.5 border-t border-border sticky bottom-0 bg-card">
          <button
            onClick={onClose}
            className="font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] border border-border text-foreground hover:border-muted-foreground/40"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isConvertingToTask}
            className="font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] bg-primary text-primary-foreground disabled:opacity-50"
          >
            {isConvertingToTask ? "Converting…" : "Convert to Task"}
          </button>
        </div>
      </div>
    </div>
  );
}