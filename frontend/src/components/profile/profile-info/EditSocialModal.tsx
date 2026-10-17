"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import { X, ChevronDown, Trash2, Loader2 } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";

interface SocialEntry {
  id: string;
  platform: string;
  username: string;
}

interface EditSocialModalProps {
  open: boolean;
  onClose: () => void;
}

const PLATFORMS = [
  "WhatsApp", "Instagram", "Facebook", "Twitter / X",
  "LinkedIn", "TikTok", "Snapchat", "YouTube", "Telegram", "Other",
];

const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="text-[14px] font-medium text-[#1A1A1A] mb-2 block font-poppins">
    {children}
  </label>
);

const InputContainer = ({ children }: { children: React.ReactNode }) => (
  <div className="w-full bg-[#F5F5F5] rounded-[14px] px-5 py-[18px] flex items-center min-h-[60px] border border-transparent focus-within:border-gray-200 transition-all gap-3">
    {children}
  </div>
);

function EntryForm({
  entry,
  total,
  onChange,
  onRemove,
}: {
  entry: SocialEntry;
  total: number;
  onChange: (updated: SocialEntry) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label>Social</Label>
          {total > 1 && (
            <button onClick={onRemove} className="text-red-400 hover:text-red-600 transition-colors">
              <Trash2 size={15} />
            </button>
          )}
        </div>
        <InputContainer>
          <select
            value={entry.platform}
            onChange={(e) => onChange({ ...entry, platform: e.target.value })}
            className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins appearance-none cursor-pointer"
            style={{ color: entry.platform ? "#000" : "#B0B0B0" }}
          >
            <option value="" disabled style={{ color: "#B0B0B0" }}>Select Social</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p} style={{ color: "#000" }}>{p}</option>
            ))}
          </select>
          <ChevronDown size={24} className="text-[#8E949A] flex-shrink-0" />
        </InputContainer>
      </div>

      <div>
        <Label>Username</Label>
        <InputContainer>
          <input
            className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-black placeholder:text-[#B0B0B0]"
            placeholder="Enter username"
            value={entry.username}
            onChange={(e) => onChange({ ...entry, username: e.target.value })}
          />
        </InputContainer>
      </div>
    </div>
  );
}

export default function EditSocialModal({ open, onClose }: EditSocialModalProps) {
  const { profile, updateSocialLinks, isUpdatingProfile, error, clearError } = useProfileStore();
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const buildEntries = (): SocialEntry[] => {
    if (!profile?.socialLinks?.length) {
      return [{ id: Date.now().toString(), platform: "", username: "" }];
    }
    return profile.socialLinks.map((s) => ({
      id:       s.id,
      platform: s.platform,
      username: s.username,
    }));
  };

  const [entries, setEntries] = useState<SocialEntry[]>(buildEntries);

  useEffect(() => {
    if (!open) return;
    // Defer hydration outside the effect's synchronous render phase.
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setEntries(buildEntries());
      clearError();
      setToast(null);
    });
    return () => { active = false; };
  }, [open, profile]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const addEntry = () =>
    setEntries((prev) => [...prev, { id: Date.now().toString(), platform: "", username: "" }]);

  const updateEntry = (index: number, updated: SocialEntry) =>
    setEntries((prev) => prev.map((e, i) => (i === index ? updated : e)));

  const removeEntry = (index: number) =>
    setEntries((prev) => prev.filter((_, i) => i !== index));

  const handleSave = async () => {
    try {
      await updateSocialLinks({
        links: entries
          .filter((e) => e.platform && e.username.trim())
          .map((e) => ({ platform: e.platform, username: e.username.trim() })),
      });
      setToast({ type: "success", message: "Social links updated successfully." });
      setTimeout(() => onClose(), 1200);
    } catch {
      setToast({ type: "error", message: error || "Something went wrong. Please try again." });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-black/50 backdrop-blur-sm" />
        <DialogContent className="fixed left-[50%] top-[50%] translate-x-[-50%] translate-y-[-50%] w-[95%] !max-w-[850px] h-fit max-h-[92vh] bg-white rounded-[32px] border-0 p-0 overflow-hidden flex flex-col outline-none shadow-2xl [&>button]:hidden">

          {/* Toast */}
          {toast && (
            <div className={`fixed top-5 right-5 z-[100] px-4 py-3 rounded-[10px] shadow-lg text-[13px] font-poppins text-white transition-all ${
              toast.type === "success" ? "bg-green-500" : "bg-red-500"
            }`}>
              {toast.message}
            </div>
          )}

          <div className="flex items-center justify-between px-6 sm:px-10 pt-8 sm:pt-10 pb-4 bg-white flex-shrink-0">
            <DialogTitle className="text-[20px] sm:text-[24px] font-bold text-black font-poppins tracking-tight">
              Social
            </DialogTitle>
            <button
              onClick={onClose}
              disabled={isUpdatingProfile}
              className="text-black transition-opacity hover:opacity-50 disabled:opacity-30"
            >
              <X size={32} strokeWidth={2.5} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 sm:px-10 pb-12">
            <div className="flex flex-col gap-8 mt-4">

              <div className="flex justify-end -mt-2">
                <button
                  onClick={addEntry}
                  className="text-[#2D31A6] text-[14px] font-semibold font-poppins hover:opacity-70 transition-opacity"
                >
                  + Add New
                </button>
              </div>

              {entries.map((entry, index) => (
                <div key={entry.id}>
                  <EntryForm
                    entry={entry}
                    total={entries.length}
                    onChange={(updated) => updateEntry(index, updated)}
                    onRemove={() => removeEntry(index)}
                  />
                  {index < entries.length - 1 && (
                    <div className="mt-8 border-t border-gray-100" />
                  )}
                </div>
              ))}

              <div className="flex justify-center mt-4">
                <button
                  onClick={handleSave}
                  disabled={isUpdatingProfile}
                  className="bg-[#2D31A6] text-white font-bold text-[18px] w-full max-w-[420px] py-[22px] rounded-[16px] shadow-xl hover:opacity-90 active:scale-[0.98] transition-all font-poppins disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isUpdatingProfile ? (
                    <>
                      <Loader2 size={20} className="animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save"
                  )}
                </button>
              </div>

            </div>
          </div>

        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}