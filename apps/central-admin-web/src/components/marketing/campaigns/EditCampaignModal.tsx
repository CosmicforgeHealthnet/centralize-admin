// src/components/marketing/campaigns/EditCampaignModal.tsx
"use client";

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";
import type { CampaignDetail } from "@/types/marketing.types";

const CAMPAIGN_TYPES = ["Email", "Social", "Ads", "Events"];

interface Props {
  campaign: CampaignDetail;
  onClose: () => void;
}

export default function EditCampaignModal({ campaign, onClose }: Props) {
  const [title, setTitle] = useState(campaign.title || "");
const [type, setType] = useState<string>(campaign.type || "");
  const [typeOpen, setTypeOpen] = useState(false);
  const [targetAudience, setTargetAudience] = useState(campaign.targetAudience || "");
  const [duration, setDuration] = useState(campaign.duration || "");
  const [budget, setBudget] = useState(campaign.budget != null ? String(campaign.budget) : "");
  const [overview, setOverview] = useState(campaign.overview || "");
  const [estCompletion, setEstCompletion] = useState(campaign.estCompletion || "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { updateCampaign, error } = useMarketingStore();

  async function handleSave() {
    if (!title || !type) return;

    setIsSubmitting(true);
    try {
      await updateCampaign(campaign.id, {
        title,
        type: type as "Email" | "Social" | "Events" | "Ads",
        targetAudience: targetAudience || undefined,
        duration: duration || undefined,
        budget: budget ? Number(budget) : undefined,
        overview: overview || undefined,
        estCompletion: estCompletion || undefined,
      });
      onClose();
    } catch (err) {
      // Error handled by store
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl w-full max-w-[520px] p-5 sm:p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[15px] font-semibold text-foreground">Edit Campaign</h3>
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
          <label className="font-poppins text-[12px] font-medium text-foreground">Enter Campaign Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter Campaign Title"
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5 relative">
          <label className="font-poppins text-[12px] font-medium text-foreground">Campaign Type</label>
          <button
            onClick={() => setTypeOpen((v) => !v)}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-left outline-none flex items-center justify-between transition-colors"
          >
            <span className={type ? "text-foreground" : "text-muted-foreground"}>
              {type || "Select Campaign Type"}
            </span>
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          </button>
          {typeOpen && (
            <div className="absolute top-[68px] left-0 right-0 z-10 bg-card border border-border rounded-lg shadow-lg py-1.5">
              {CAMPAIGN_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setType(t);
                    setTypeOpen(false);
                  }}
                  className="w-full text-left px-3.5 py-2 text-[13px] font-poppins text-foreground hover:bg-muted/50 transition-colors"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Target Audience</label>
          <input
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
            placeholder="e.g. New Users, Enterprise Clients"
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Duration</label>
          <input
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="e.g. 30 days"
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Budget</label>
          <input
            type="number"
            min="0"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="0"
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Est. Completion Date</label>
          <input
            type="date"
            value={estCompletion}
            onChange={(e) => setEstCompletion(e.target.value)}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Campaign Overview</label>
          <textarea
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
            placeholder="Campaign overview....."
            rows={4}
            className="w-full px-3.5 py-3 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors resize-none placeholder:text-muted-foreground"
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
            onClick={handleSave}
            disabled={!title || !type || isSubmitting}
            className="px-5 py-2.5 bg-primary text-white rounded-lg text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}