"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { createAECreativePublication } from "@/lib/advertising-execution.service";

interface CreatePublicationRevisionModalProps {
  sourceAssetId: string;
  onCreated: (publicationId: string) => void;
  onClose: () => void;
}

export default function CreatePublicationRevisionModal({ sourceAssetId, onCreated, onClose }: CreatePublicationRevisionModalProps) {
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [cta, setCta] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [accessibilityText, setAccessibilityText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = headline.trim() && destinationUrl.trim() && accessibilityText.trim();

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const pub = await createAECreativePublication(sourceAssetId, {
        copy: { headline, body, cta },
        destinationUrl,
        accessibilityText,
      });
      onCreated(pub.id);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-[12px] border border-border p-5 max-w-lg w-full flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Create Publication Revision</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <label className="font-poppins text-[11px] font-medium text-foreground">Headline</label>
            <input
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-poppins text-[11px] font-medium text-foreground">Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none resize-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-poppins text-[11px] font-medium text-foreground">CTA</label>
            <input
              value={cta}
              onChange={(e) => setCta(e.target.value)}
              className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-poppins text-[11px] font-medium text-foreground">Destination URL (HTTPS, approved domain)</label>
            <input
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              placeholder="https://..."
              className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-poppins text-[11px] font-medium text-foreground">Accessibility Text (required)</label>
            <input
              value={accessibilityText}
              onChange={(e) => setAccessibilityText(e.target.value)}
              className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Validate & Create Revision"}
          </button>
          <button
            onClick={onClose}
            className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}