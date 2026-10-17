"use client";

import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import { X, ChevronDown, Search, Loader2 } from "lucide-react";
import ReactCountryFlag from "react-country-flag";
import { useProfileStore } from "@/stores/profile.store";

interface PhoneField {
  iso: string;
  code: string;
  number: string;
}

interface FormState {
  nextOfKin: string;
  phone: PhoneField;
  email: string;
  relationship: string;
}

interface EditEmergencyContactModalProps {
  open: boolean;
  onClose: () => void;
}

const COUNTRIES = [
  { name: "Nigeria", code: "+234", iso: "NG" },
  { name: "Ghana", code: "+233", iso: "GH" },
  { name: "South Africa", code: "+27", iso: "ZA" },
  { name: "Kenya", code: "+254", iso: "KE" },
  { name: "United States", code: "+1", iso: "US" },
  { name: "United Kingdom", code: "+44", iso: "GB" },
  { name: "Canada", code: "+1", iso: "CA" },
  { name: "France", code: "+33", iso: "FR" },
  { name: "Germany", code: "+49", iso: "DE" },
  { name: "India", code: "+91", iso: "IN" },
  { name: "Australia", code: "+61", iso: "AU" },
  { name: "Brazil", code: "+55", iso: "BR" },
  { name: "Egypt", code: "+20", iso: "EG" },
  { name: "Ethiopia", code: "+251", iso: "ET" },
  { name: "Tanzania", code: "+255", iso: "TZ" },
  { name: "Uganda", code: "+256", iso: "UG" },
  { name: "Senegal", code: "+221", iso: "SN" },
  { name: "Cameroon", code: "+237", iso: "CM" },
  { name: "Rwanda", code: "+250", iso: "RW" },
  { name: "Morocco", code: "+212", iso: "MA" },
];

const RELATIONSHIPS = [
  "Sibling", "Parent", "Spouse", "Child", "Friend",
  "Colleague", "Guardian", "Relative", "Other",
];

function splitPhone(raw: string | null | undefined): PhoneField {
  if (!raw) return { iso: "NG", code: "+234", number: "" };
  const trimmed = raw.trim();
  const country = COUNTRIES.find((c) => trimmed.startsWith(c.code));
  if (!country) return { iso: "NG", code: "+234", number: trimmed };
  let number = trimmed.slice(country.code.length).trim();
  const inner = COUNTRIES.find((c) => number.startsWith(c.code));
  if (inner) number = number.slice(inner.code.length).trim();
  number = number.replace(/^[-\s]+/, "");
  return { iso: country.iso, code: country.code, number };
}

function formatPhone(field: PhoneField): string | null {
  if (!field.number) return null;
  return `${field.code} ${field.number}`.trim();
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

function PhoneInput({ value, onChange }: { value: PhoneField; onChange: (v: PhoneField) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const filtered = COUNTRIES.filter(
    (c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.code.includes(search)
  );

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <InputContainer>
      <div className="relative flex-shrink-0" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((p) => !p)}
          className="flex items-center gap-1.5 bg-transparent border-0 outline-none cursor-pointer"
        >
          <ReactCountryFlag
            countryCode={value.iso}
            svg
            style={{ width: "22px", height: "16px", borderRadius: "3px", objectFit: "cover" }}
          />
          <ChevronDown size={14} className="text-[#8E949A]" />
        </button>

        {open && (
          <div className="absolute top-full left-0 mt-2 w-[240px] bg-white rounded-[14px] shadow-2xl z-50 overflow-hidden border border-gray-100">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
              <Search size={14} className="text-[#8E949A]" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search country..."
                className="flex-1 text-[13px] font-poppins outline-none bg-transparent text-black placeholder:text-[#B0B0B0]"
              />
            </div>
            <div className="max-h-[200px] overflow-y-auto">
              {filtered.map((c) => (
                <button
                  key={c.iso}
                  type="button"
                  onClick={() => {
                    onChange({ ...value, iso: c.iso, code: c.code });
                    setOpen(false);
                    setSearch("");
                  }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[#F5F5F5] transition-colors text-left"
                >
                  <ReactCountryFlag
                    countryCode={c.iso}
                    svg
                    style={{ width: "20px", height: "15px", borderRadius: "2px", objectFit: "cover" }}
                  />
                  <span className="text-[13px] font-poppins text-black flex-1">{c.name}</span>
                  <span className="text-[12px] font-poppins text-[#8E949A]">{c.code}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <span className="text-[#D0D0D0] text-[18px] select-none">|</span>
      <span className="text-[15px] font-poppins text-[#8E949A] flex-shrink-0">{value.code}</span>
      <input
        type="tel"
        value={value.number}
        onChange={(e) => onChange({ ...value, number: e.target.value })}
        placeholder="Enter number"
        className="flex-1 bg-transparent border-0 outline-none text-[16px] font-poppins text-black placeholder:text-[#B0B0B0] min-w-0"
      />
    </InputContainer>
  );
}

export default function EditEmergencyContactModal({ open, onClose }: EditEmergencyContactModalProps) {
  const { profile, updateEmergencyContact, isUpdatingProfile, error, clearError } = useProfileStore();
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const buildForm = (): FormState => ({
    nextOfKin:    profile?.emergencyName     ?? "",
    phone:        splitPhone(profile?.emergencyPhone),
    email:        profile?.emergencyEmail    ?? "",
    relationship: profile?.emergencyRelation ?? "",
  });

  const [form, setForm] = useState<FormState>(buildForm);

  useEffect(() => {
    if (!open) return;
    // Defer hydration outside the effect's synchronous render phase.
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setForm(buildForm());
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

  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    try {
      await updateEmergencyContact({
        emergencyName:     form.nextOfKin    || null,
        emergencyPhone:    formatPhone(form.phone),
        emergencyEmail:    form.email        || null,
        emergencyRelation: form.relationship || null,
      });
      setToast({ type: "success", message: "Emergency contact updated successfully." });
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
              Emergency Contact
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
            <div className="flex flex-col gap-6 mt-4">

              <div>
                <Label>Next of Kin</Label>
                <InputContainer>
                  <input
                    className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-black placeholder:text-[#B0B0B0]"
                    placeholder="Enter Name"
                    value={form.nextOfKin}
                    onChange={(e) => set("nextOfKin")(e.target.value)}
                  />
                </InputContainer>
              </div>

              <div>
                <Label>Phone Number</Label>
                <PhoneInput
                  value={form.phone}
                  onChange={(v) => setForm((prev) => ({ ...prev, phone: v }))}
                />
              </div>

              <div>
                <Label>Email Address</Label>
                <InputContainer>
                  <input
                    type="email"
                    className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins text-black placeholder:text-[#B0B0B0]"
                    placeholder="Enter Email"
                    value={form.email}
                    onChange={(e) => set("email")(e.target.value)}
                  />
                </InputContainer>
              </div>

              <div>
                <Label>Relationship</Label>
                <InputContainer>
                  <select
                    value={form.relationship}
                    onChange={(e) => set("relationship")(e.target.value)}
                    className="w-full bg-transparent border-0 outline-none text-[16px] font-poppins appearance-none cursor-pointer"
                    style={{ color: form.relationship ? "#000" : "#B0B0B0" }}
                  >
                    <option value="" disabled style={{ color: "#B0B0B0" }}>Select Relationship</option>
                    {RELATIONSHIPS.map((r) => (
                      <option key={r} value={r} style={{ color: "#000" }}>{r}</option>
                    ))}
                  </select>
                  <ChevronDown size={24} className="text-[#8E949A] flex-shrink-0" />
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