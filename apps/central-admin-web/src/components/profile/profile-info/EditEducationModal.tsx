"use client";

import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import { X, Trash2, Loader2 } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";

interface EducationEntry {
  id: string;
  institution: string;
  from: string;
  to: string;
  degreeTitle: string;
}

interface EditEducationModalProps {
  open: boolean;
  onClose: () => void;
}

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
  entry: EducationEntry;
  total: number;
  onChange: (updated: EducationEntry) => void;
  onRemove: () => void;
}) {
  const set = (key: keyof EducationEntry) => (value: string) =>
    onChange({ ...entry, [key]: value });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label>Institution</Label>
          {total > 1 && (
            <button onClick={onRemove} className="text-red-400 hover:text-red-600 transition-colors">
              <Trash2 size={15} />
            </button>
          )}
        </div>
        <InputContainer>
          <input
            className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-black placeholder:text-[#B0B0B0]"
            placeholder="Enter Institution"
            value={entry.institution}
            onChange={(e) => set("institution")(e.target.value)}
          />
        </InputContainer>
      </div>

      <div>
        <Label>Certificate / Degree Title</Label>
        <InputContainer>
          <input
            className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-black placeholder:text-[#B0B0B0]"
            placeholder="Enter Title"
            value={entry.degreeTitle}
            onChange={(e) => set("degreeTitle")(e.target.value)}
          />
        </InputContainer>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>From</Label>
          <InputContainer>
            <input
              type="text"
              className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-black placeholder:text-[#B0B0B0]"
              placeholder="e.g. 2019"
              value={entry.from}
              onChange={(e) => set("from")(e.target.value)}
            />
          </InputContainer>
        </div>
        <div>
          <Label>To</Label>
          <InputContainer>
            <input
              type="text"
              className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-black placeholder:text-[#B0B0B0]"
              placeholder="e.g. 2023"
              value={entry.to}
              onChange={(e) => set("to")(e.target.value)}
            />
          </InputContainer>
        </div>
      </div>
    </div>
  );
}

export default function EditEducationModal({ open, onClose }: EditEducationModalProps) {
  const { profile, updateEducation, isUpdatingProfile, error, clearError } = useProfileStore();
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const buildEntries = (): EducationEntry[] => {
    if (!profile?.educations?.length) {
      return [{ id: Date.now().toString(), institution: "", degreeTitle: "", from: "", to: "" }];
    }
    return profile.educations.map((e) => ({
      id:          e.id,
      institution: e.institution,
      degreeTitle: e.degreeTitle,
      from:        e.from ?? "",
      to:          e.to   ?? "",
    }));
  };

  const [entries, setEntries] = useState<EducationEntry[]>(buildEntries);

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

  const addEntry = () => {
    setEntries((prev) => [
      ...prev,
      { id: Date.now().toString(), institution: "", degreeTitle: "", from: "", to: "" },
    ]);
  };

  const updateEntry = (index: number, updated: EducationEntry) => {
    setEntries((prev) => prev.map((e, i) => (i === index ? updated : e)));
  };

  const removeEntry = (index: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    try {
      await updateEducation({
        entries: entries
          .filter((e) => e.institution.trim() && e.degreeTitle.trim())
          .map((e) => ({
            degreeTitle: e.degreeTitle.trim(),
            institution: e.institution.trim(),
            from:        e.from.trim() || null,
            to:          e.to.trim()   || null,
          })),
      });
      setToast({ type: "success", message: "Education updated successfully." });
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
              Education & Certifications
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
            <div className="flex flex-col gap-10 mt-4">

              <div className="flex justify-end">
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
            </div>

            <div className="flex justify-center mt-10">
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

        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}