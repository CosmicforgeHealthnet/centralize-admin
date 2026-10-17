// src/components/marketing/banners-promotion/NewBannerPage.tsx
"use client";

import { useState } from "react";
import { ArrowLeft, Upload, X } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";

const DISPLAY_OPTIONS = ["WEB", "APP", "Both"];
const PLACEMENT_OPTIONS = ["Homepage", "Dashboard", "Other"];

interface Props {
  onBack: () => void;
}

export default function NewBannerPage({ onBack }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [display, setDisplay] = useState<string[]>([]);
  const [placement, setPlacement] = useState<string[]>([]);
  const [externalLink, setExternalLink] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { createBanner, error } = useMarketingStore();

  function toggle(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  const handleCreate = async () => {
    if (!title || !file) return;

    setIsSubmitting(true);
    try {
      await createBanner({
        title,
        description,
        display: display.join(","),
        placement: placement.join(","),
        externalLink,
        startDate,
        endDate,
        file,
      });
      onBack();
    } catch (err) {
      // Error handled by store
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Banners & Promotion</span>
      </button>

      <div>
        <h2 className="font-poppins text-[16px] font-semibold text-foreground">New Banner</h2>
        <p className="font-poppins text-[12px] text-muted-foreground mt-0.5">Auto-Updates in 2 minutes</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      <label className="border-2 border-dashed border-border rounded-xl flex flex-col items-center justify-center gap-3 py-14 cursor-pointer hover:border-primary/40 transition-colors">
        <input
          type="file"
          className="hidden"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
          <Upload className="w-4.5 h-4.5 text-muted-foreground" />
        </div>
        <span className="font-poppins text-[13px] font-semibold text-foreground">
          {file ? file.name : "Upload file here"}
        </span>
        {file && (
          <button
            onClick={(e) => { e.preventDefault(); setFile(null); }}
            className="text-red-500 hover:text-red-400 text-sm"
          >
            Remove file
          </button>
        )}
      </label>
      <div className="flex items-center justify-between">
        <span className="font-poppins text-[11px] text-muted-foreground">Supported format: JPG, PNG, WebP</span>
        <span className="font-poppins text-[11px] text-muted-foreground">Maximum size: 5MB</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="font-poppins text-[12px] font-medium text-foreground">Ad Banner Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Enter Banner Title"
          className="w-full h-[44px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="font-poppins text-[12px] font-medium text-foreground">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description......"
          rows={3}
          className="w-full px-3.5 py-3 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors resize-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="font-poppins text-[12px] font-medium text-foreground">Display Settings</label>
        <div className="bg-primary/8 rounded-lg p-4 flex flex-col gap-2.5">
          {DISPLAY_OPTIONS.map((opt) => (
            <label key={opt} className="flex items-center gap-2.5 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={display.includes(opt)}
                onChange={() => toggle(display, setDisplay, opt)}
                className="w-4 h-4 rounded border-border accent-primary"
              />
              <span className="font-poppins text-[13px] text-foreground">{opt}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="font-poppins text-[12px] font-medium text-foreground">Placement</label>
        <div className="bg-primary/8 rounded-lg p-4 flex flex-col gap-2.5">
          {PLACEMENT_OPTIONS.map((opt) => (
            <label key={opt} className="flex items-center gap-2.5 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={placement.includes(opt)}
                onChange={() => toggle(placement, setPlacement, opt)}
                className="w-4 h-4 rounded border-border accent-primary"
              />
              <span className="font-poppins text-[13px] text-foreground">{opt}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="font-poppins text-[12px] font-medium text-foreground">External Link</label>
        <input
          value={externalLink}
          onChange={(e) => setExternalLink(e.target.value)}
          placeholder="https://example.com"
          className="w-full h-[44px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="font-poppins text-[12px] font-medium text-foreground">Start Date</label>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="w-full h-[44px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="font-poppins text-[12px] font-medium text-foreground">End Date</label>
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="w-full h-[44px] px-3.5 bg-muted/50 border border-border rounded-lg text-[13px] font-poppins text-foreground outline-none focus:border-primary/50 transition-colors"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          disabled={isSubmitting}
          className="px-6 py-2.5 border border-border rounded-lg text-[13px] font-poppins font-semibold text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleCreate}
          disabled={!title || !file || isSubmitting}
          className="px-6 py-2.5 bg-primary text-white rounded-lg text-[13px] font-poppins font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "Creating..." : "Create"}
        </button>
      </div>
    </div>
  );
}