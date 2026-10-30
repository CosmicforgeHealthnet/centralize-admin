"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { classifyMailError } from "@/lib/mail.service";
import { setTemplateClassification } from "@/lib/mail-marketing.service";
import type { MarketingOrganization, TemplateClassification } from "@/types/mail-marketing.types";
import StepUpDialog from "./StepUpDialog";
import { CLASSIFICATION_LABELS, ClassificationBadge } from "./QaStatusBadge";
import { EmField, EmMessage, emBtn, emBtnOutline, emInput } from "./em-ui";

const OPTIONS: TemplateClassification[] = ["MARKETING", "TRANSACTIONAL", "TRANSACTIONAL_SECURITY"];
const HELP: Record<TemplateClassification, string> = {
  MARKETING: "Consent-backed audiences only. Unsubscribe, consent and postal address footer are mandatory.",
  TRANSACTIONAL: "Service messages. No marketing footer, no promotional blocks, never sendable to a marketing audience.",
  TRANSACTIONAL_SECURITY: "Security messages. No images, no tracked or external links, plain text required; every version needs a second approver.",
};

/**
 * Template classification badge + change control. Changes into or out of a
 * transactional class need a brand approver, a reason and an MFA step-up; the
 * server then saves the latest content as a new version under the new class.
 */
export default function TemplateClassificationControl({
  org,
  templateId,
  classification,
  available,
  onChanged,
}: {
  org: MarketingOrganization;
  templateId: string;
  classification: TemplateClassification;
  available: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<TemplateClassification>(classification);
  const [reason, setReason] = useState("");
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);

  const privileged = target !== "MARKETING" || classification !== "MARKETING";
  const allowed = privileged ? org.canApprove : org.canAuthor;

  const change = useMutation({
    mutationFn: (stepUpId?: string) => setTemplateClassification(org.id, templateId, { classification: target, reason: reason.trim(), stepUpId }),
    onSuccess: (r) => {
      setStepUpOpen(false);
      setOpen(false);
      setReason("");
      setMsg({ text: r.newVersion ? `Classified as ${CLASSIFICATION_LABELS[r.classification]}. Saved as new version v${r.newVersion.version}; earlier versions keep their class.` : `Classified as ${CLASSIFICATION_LABELS[r.classification]}.`, tone: "info" });
      onChanged();
    },
    onError: (e) => {
      setStepUpOpen(false);
      const info = classifyMailError(e);
      setMsg({ text: info.code === "MAIL_FEATURE_NOT_READY" ? "Classification is not available until the database migration is applied." : info.message, tone: "error" });
    },
  });

  const apply = () => {
    setMsg(null);
    if (privileged) setStepUpOpen(true);
    else change.mutate(undefined);
  };

  return (
    <div className="flex flex-col gap-2" aria-label="Template classification">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-muted-foreground">Classification</span>
        <ClassificationBadge value={classification} />
        {!available && <span className="text-[11px] text-muted-foreground">(classification not available yet: all templates are marketing)</span>}
        {available && (org.canApprove || org.canAuthor) && !open && (
          <button type="button" className={emBtnOutline} onClick={() => { setTarget(classification); setOpen(true); }}>
            Change classification
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{HELP[classification]}</p>
      {open && (
        <form
          className="flex flex-col gap-2 rounded-md border border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <EmField label="New classification">
            <select aria-label="New classification" value={target} onChange={(e) => setTarget(e.target.value as TemplateClassification)} className={emInput}>
              {OPTIONS.map((o) => <option key={o} value={o}>{CLASSIFICATION_LABELS[o]}</option>)}
            </select>
          </EmField>
          <p className="text-[11px] text-muted-foreground">{HELP[target]}</p>
          <EmField label="Reason (audited)">
            <textarea aria-label="Classification reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={emInput} />
          </EmField>
          {privileged && <p className="text-[11px] text-amber-700">Requires a brand approver and a fresh 2FA code. The latest content is saved as a new version under the new class.</p>}
          {!allowed && <p className="text-[11px] text-red-600">{privileged ? "Only brand approvers can change a transactional classification." : "Only brand authors can change the classification."}</p>}
          <div className="flex gap-2">
            <button type="submit" className={emBtn} disabled={!allowed || target === classification || reason.trim().length < 5 || change.isPending}>
              {privileged ? "Apply (requires 2FA)" : "Apply"}
            </button>
            <button type="button" className={emBtnOutline} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
      {msg && <EmMessage message={msg.text} tone={msg.tone} />}
      {stepUpOpen && (
        <StepUpDialog
          purpose="MARKETING_TEMPLATE_CLASSIFY"
          title="Confirm template classification change"
          onCancel={() => setStepUpOpen(false)}
          onVerified={(id) => change.mutateAsync(id).then(() => undefined)}
        />
      )}
    </div>
  );
}
