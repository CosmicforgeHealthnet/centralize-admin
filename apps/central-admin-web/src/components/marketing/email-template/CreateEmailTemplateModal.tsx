// src/components/marketing/email-template/CreateEmailTemplateModal.tsx
"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";

interface Props {
  onClose: () => void;
}

export default function CreateEmailTemplateModal({ onClose }: Props) {
  const [event, setEvent] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [language, setLanguage] = useState("EN");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { createEmailTemplate, error } = useMarketingStore();

  const handleCreate = async () => {
    if (!event || !validFrom || !validTo || !language) return;

    setIsSubmitting(true);
    try {
      await createEmailTemplate({
        event,
        validFrom,
        validTo,
        language,
      });
      onClose();
    } catch (err) {
      // Error handled by store
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl w-full max-w-[480px] p-5 sm:p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[15px] font-semibold text-foreground">Create Email Template</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Event Name</label>
          <input
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            placeholder="e.g. Order Shipped"
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Valid From</label>
          <input
            type="date"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Valid To</label>
          <input
            type="date"
            value={validTo}
            onChange={(e) => setValidTo(e.target.value)}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Language</label>
          <input
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="EN"
            maxLength={20}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="px-5 py-2.5 border border-border rounded-lg text-[13px] font-poppins font-semibold text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!event || !validFrom || !validTo || !language || isSubmitting}
            className="px-5 py-2.5 bg-primary text-white rounded-lg text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}