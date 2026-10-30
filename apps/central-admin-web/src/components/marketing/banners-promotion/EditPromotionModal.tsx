// src/components/marketing/banners-promotion/EditPromotionModal.tsx
"use client";

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";
import type { PromotionListItem } from "@/types/marketing.types";

const DISCOUNT_TYPES = ["50% off Subscription", "Percentage Discount", "Fixed Amount", "Free Trial Extension"];

interface Props {
  promotion: PromotionListItem;
  onClose: () => void;
}

export default function EditPromotionModal({ promotion, onClose }: Props) {
  const [title, setTitle] = useState(promotion.title || "");
  const [discountType, setDiscountType] = useState(promotion.discountType || "");
  const [typeOpen, setTypeOpen] = useState(false);
  const [startDate, setStartDate] = useState(promotion.startDate || "");
  const [endDate, setEndDate] = useState(promotion.endDate || "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { updatePromotion, error } = useMarketingStore();

  const handleSave = async () => {
    if (!title || !discountType || !startDate || !endDate) return;

    setIsSubmitting(true);
    try {
      await updatePromotion(promotion.id, {
        title,
        discountType,
        startDate,
        endDate,
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
          <h3 className="font-poppins text-[15px] font-semibold text-foreground">Edit Promotion</h3>
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
          <label className="font-poppins text-[12px] font-medium text-foreground">Enter Promotion Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter Promotion Title"
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5 relative">
          <label className="font-poppins text-[12px] font-medium text-foreground">Discount Type</label>
          <button
            onClick={() => setTypeOpen((v) => !v)}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-left outline-none flex items-center justify-between"
          >
            <span className={discountType ? "text-foreground" : "text-muted-foreground"}>
              {discountType || "Select Discount Type"}
            </span>
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          </button>
          {typeOpen && (
            <div className="absolute top-[68px] left-0 right-0 z-10 bg-card border border-border rounded-lg shadow-lg py-1.5">
              {DISCOUNT_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => { setDiscountType(t); setTypeOpen(false); }}
                  className="w-full text-left px-3.5 py-2 text-[13px] font-poppins text-foreground hover:bg-muted/50 transition-colors"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">End Date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors"
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
            disabled={!title || !discountType || !startDate || !endDate || isSubmitting}
            className="px-5 py-2.5 bg-primary text-white rounded-lg text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}