"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import { X, CalendarIcon, ChevronDown, Loader2 } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";

interface FormState {
  preferredName: string;
  birthday: string;
  nationality: string;
  gender: string;
  maritalStatus: string;
}

interface EditPersonalInfoModalProps {
  open: boolean;
  onClose: () => void;
}

const nationalities = [
  "Nigerian", "Ghanaian", "South African", "Kenyan", "American",
  "British", "Canadian", "French", "German", "Indian",
  "Chinese", "Brazilian", "Australian", "Egyptian", "Ethiopian",
];
const genderOptions = ["Male", "Female", "Non-binary", "Prefer not to say"];
const maritalOptions = ["Single", "Married", "Divorced", "Widowed", "Separated"];

const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="text-[14px] font-medium text-[#1A1A1A] mb-2 block font-poppins">
    {children}
  </label>
);

const InputContainer = ({ children }: { children: React.ReactNode }) => (
  <div className="w-full bg-[#F5F5F5] rounded-[14px] px-5 py-[18px] flex items-center min-h-[60px] border border-transparent focus-within:border-gray-200 transition-all">
    {children}
  </div>
);

export default function EditPersonalInfoModal({ open, onClose }: EditPersonalInfoModalProps) {
  const { profile, updatePersonalInfo, isUpdatingProfile, error, clearError } = useProfileStore();
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const buildForm = (): FormState => ({
    preferredName: profile?.preferredName ?? "",
    birthday:      profile?.birthday      ?? "",
    nationality:   profile?.nationality   ?? "",
    gender:        profile?.gender        ?? "",
    maritalStatus: profile?.maritalStatus ?? "",
  });

  const [form, setForm] = useState<FormState>(buildForm);

  useEffect(() => {
    if (open) {
      setForm(buildForm());
      clearError();
      setToast(null);
    }
  }, [open, profile]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    try {
      await updatePersonalInfo({
        preferredName: form.preferredName || null,
        birthday:      form.birthday      || null,
        nationality:   form.nationality   || null,
        gender:        form.gender        || null,
        maritalStatus: form.maritalStatus || null,
      });
      setToast({ type: "success", message: "Personal info updated successfully." });
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

          {/* Header */}
          <div className="flex items-center justify-between px-6 sm:px-10 pt-8 sm:pt-10 pb-4 bg-white flex-shrink-0">
            <DialogTitle className="text-[20px] sm:text-[24px] font-bold text-black font-poppins tracking-tight">
              Personal Information
            </DialogTitle>
            <button
              onClick={onClose}
              disabled={isUpdatingProfile}
              className="text-black transition-opacity hover:opacity-50 disabled:opacity-30"
            >
              <X size={32} strokeWidth={2.5} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 sm:px-10 pb-12">
            <div className="flex flex-col gap-6 mt-4">

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <Label>First Name</Label>
                  <InputContainer>
                    <input
                      readOnly
                      className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-[#8E949A] cursor-not-allowed"
                      value={profile?.name?.split(" ")[0] ?? ""}
                    />
                  </InputContainer>
                </div>
                <div>
                  <Label>Surname</Label>
                  <InputContainer>
                    <input
                      readOnly
                      className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-[#8E949A] cursor-not-allowed"
                      value={profile?.name?.split(" ").slice(1).join(" ") ?? ""}
                    />
                  </InputContainer>
                </div>
              </div>

              <div>
                <Label>Preferred Name</Label>
                <InputContainer>
                  <input
                    className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-black placeholder:text-[#B0B0B0]"
                    placeholder="Enter preferred name"
                    value={form.preferredName}
                    onChange={(e) => set("preferredName")(e.target.value)}
                  />
                </InputContainer>
              </div>

              <div>
                <Label>Birthday</Label>
                <InputContainer>
                  <input
                    type="date"
                    className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-black appearance-none"
                    value={form.birthday}
                    onChange={(e) => set("birthday")(e.target.value)}
                  />
                  <CalendarIcon size={24} className="text-[#8E949A] shrink-0" />
                </InputContainer>
              </div>

              <div>
                <Label>Nationality</Label>
                <InputContainer>
                  <select
                    className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins appearance-none cursor-pointer"
                    style={{ color: form.nationality ? "#000" : "#B0B0B0" }}
                    value={form.nationality}
                    onChange={(e) => set("nationality")(e.target.value)}
                  >
                    <option value="" disabled style={{ color: "#B0B0B0" }}>Select Nationality</option>
                    {nationalities.map((n) => (
                      <option key={n} value={n} style={{ color: "#000" }}>{n}</option>
                    ))}
                  </select>
                  <ChevronDown size={24} className="text-[#8E949A] shrink-0" />
                </InputContainer>
              </div>

              <div>
                <Label>Gender</Label>
                <InputContainer>
                  <select
                    className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins appearance-none cursor-pointer"
                    style={{ color: form.gender ? "#000" : "#B0B0B0" }}
                    value={form.gender}
                    onChange={(e) => set("gender")(e.target.value)}
                  >
                    <option value="" disabled style={{ color: "#B0B0B0" }}>Select Gender</option>
                    {genderOptions.map((g) => (
                      <option key={g} value={g} style={{ color: "#000" }}>{g}</option>
                    ))}
                  </select>
                  <ChevronDown size={24} className="text-[#8E949A] shrink-0" />
                </InputContainer>
              </div>

              <div>
                <Label>Marital Status</Label>
                <InputContainer>
                  <select
                    className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins appearance-none cursor-pointer"
                    style={{ color: form.maritalStatus ? "#000" : "#B0B0B0" }}
                    value={form.maritalStatus}
                    onChange={(e) => set("maritalStatus")(e.target.value)}
                  >
                    <option value="" disabled style={{ color: "#B0B0B0" }}>Select Status</option>
                    {maritalOptions.map((m) => (
                      <option key={m} value={m} style={{ color: "#000" }}>{m}</option>
                    ))}
                  </select>
                  <ChevronDown size={24} className="text-[#8E949A] shrink-0" />
                </InputContainer>
              </div>

              <div className="flex justify-center mt-8">
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