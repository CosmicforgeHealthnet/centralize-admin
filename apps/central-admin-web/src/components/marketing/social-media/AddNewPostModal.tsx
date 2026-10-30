// src/components/marketing/social-media/AddNewPostModal.tsx
"use client";

import { useState } from "react";
import { ChevronDown, X, Smile, Paperclip } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";
import type { SocialPlatform } from "@/types/marketing.types";

const PLATFORMS: SocialPlatform[] = ["Facebook", "Instagram", "Twitter", "Tiktok", "LinkedIn", "Youtube"];

interface Props {
  onClose: () => void;
}

export default function AddNewPostModal({ onClose }: Props) {
  const [platform, setPlatform] = useState<SocialPlatform | "">("");
  const [platformOpen, setPlatformOpen] = useState(false);
  const [caption, setCaption] = useState("");
  const [attachment, setAttachment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { createSocialPost, error } = useMarketingStore();

  async function handleSend() {
    if (!platform || !caption) return;

    setIsSubmitting(true);
    try {
      await createSocialPost({
        platform: platform,
        caption,
        attachmentUrl: attachment || undefined,
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
      <div className="bg-white rounded-xl w-full max-w-[480px] p-5 sm:p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[15px] font-semibold text-foreground">Add New Post</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-1.5 relative">
          <label className="font-poppins text-[12px] font-medium text-foreground">Select social media platform</label>
          <button
            onClick={() => setPlatformOpen((v) => !v)}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-left outline-none flex items-center justify-between"
          >
            <span className={platform ? "text-foreground" : "text-muted-foreground"}>{platform || "Select Platform"}</span>
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          </button>
          {platformOpen && (
            <div className="absolute top-[68px] left-0 right-0 z-10 bg-card border border-border rounded-lg shadow-lg py-1.5 max-h-[180px] overflow-y-auto">
              {PLATFORMS.map((p) => (
                <button
                  key={p}
                  onClick={() => { setPlatform(p); setPlatformOpen(false); }}
                  className="w-full text-left px-3.5 py-2 text-[13px] font-poppins text-foreground hover:bg-muted/50 transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Add Caption</label>
          <div className="flex items-center gap-2 px-3.5 h-[42px] bg-muted/50 border border-border rounded-lg focus-within:border-primary/50 transition-colors">
            <Smile className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write a message..."
              className="bg-transparent text-[13px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Attachment (URL)</label>
          <div className="flex items-center gap-2 px-3.5 h-[42px] bg-muted/50 border border-border rounded-lg focus-within:border-primary/50 transition-colors">
            <input
              value={attachment}
              onChange={(e) => setAttachment(e.target.value)}
              placeholder="https://example.com/image.jpg"
              className="bg-transparent text-[13px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
            />
            <Paperclip className="w-4 h-4 text-primary shrink-0" />
          </div>
        </div>

        <button
          onClick={handleSend}
          disabled={!platform || !caption || isSubmitting}
          className="w-full py-3 bg-primary text-white rounded-lg text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-1"
        >
          {isSubmitting ? "Sending..." : "Send Post"}
        </button>
      </div>
    </div>
  );
}