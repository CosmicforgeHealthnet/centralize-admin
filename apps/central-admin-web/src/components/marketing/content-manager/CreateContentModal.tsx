// src/components/marketing/content-manager/CreateContentModal.tsx
"use client";

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";
import { useAuthStore } from "@/stores/auth.store";

const CONTENT_TYPES = ["Article", "Video", "Infographic", "Guide"];

interface Props {
  onClose: () => void;
}

export default function CreateContentModal({ onClose }: Props) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("");
  const [typeOpen, setTypeOpen] = useState(false);
  const [link, setLink] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { createContent, error } = useMarketingStore();
  const currentUser = useAuthStore((state) => state.user);

  const handleCreate = async () => {
    if (!title || !type || !currentUser?.id) return;

    setIsSubmitting(true);
    try {
      await createContent({
        title,
        type,
        authorId: currentUser.id,
        link,
        description,
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
      <div className="bg-white rounded-xl w-full max-w-[560px] p-5 sm:p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[15px] font-semibold text-foreground">Create New Content</h3>
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
          <label className="font-poppins text-[12px] font-medium text-foreground">Enter Content Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter Content Title"
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5 relative">
          <label className="font-poppins text-[12px] font-medium text-foreground">Content Type</label>
          <button
            onClick={() => setTypeOpen((v) => !v)}
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-left outline-none flex items-center justify-between"
          >
            <span className={type ? "text-foreground" : "text-muted-foreground"}>
              {type || "Select Content Type"}
            </span>
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          </button>
          {typeOpen && (
            <div className="absolute top-[68px] left-0 right-0 z-10 bg-card border border-border rounded-lg shadow-lg py-1.5">
              {CONTENT_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => { setType(t); setTypeOpen(false); }}
                  className="w-full text-left px-3.5 py-2 text-[13px] font-poppins text-foreground hover:bg-muted/50 transition-colors"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Author</label>
          <div className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground flex items-center">
            {currentUser?.name || currentUser?.email || "Unknown"}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Enter Link (Optional)</label>
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://example.com/content"
            className="w-full h-[42px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="font-poppins text-[12px] font-medium text-foreground">Description (Optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Content description..."
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
            onClick={handleCreate}
            disabled={!title || !type || !currentUser?.id || isSubmitting}
            className="px-5 py-2.5 bg-primary text-white rounded-lg text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}