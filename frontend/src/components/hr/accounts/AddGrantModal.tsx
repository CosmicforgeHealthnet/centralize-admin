"use client";

import { useState, useEffect } from "react";
import { X, Plus, Loader2, AlertCircle } from "lucide-react";
import {
  MODULES,
  MODULE_SECTIONS,
  Module,
  SectionGrantMode,
  CreateSectionGrantPayload,
} from "@/types/hrm.types";

interface AddGrantModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (grant: CreateSectionGrantPayload) => Promise<void>;
  existingGrants?: { module: Module; section: string }[];
  isLoading?: boolean;
  error?: string | null;
}

export default function AddGrantModal({
  isOpen,
  onClose,
  onAdd,
  existingGrants = [],
  isLoading = false,
  error = null,
}: AddGrantModalProps) {
  const [selectedModule, setSelectedModule] = useState<Module | "">("");
  const [selectedSection, setSelectedSection] = useState<string>("");
  const [selectedMode, setSelectedMode] = useState<SectionGrantMode>("VIEW");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset form when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedModule("");
      setSelectedSection("");
      setSelectedMode("VIEW");
      setLocalError(null);
    }
  }, [isOpen]);

  // Available sections based on selected module
  const availableSections = selectedModule ? MODULE_SECTIONS[selectedModule] || [] : [];

  // Check if grant already exists
  const isDuplicate = (module: Module, section: string) => {
    return existingGrants.some((g) => g.module === module && g.section === section);
  };

  // Handle submit
  const handleSubmit = async () => {
    if (!selectedModule || !selectedSection) {
      setLocalError("Please select both a module and a section.");
      return;
    }

    if (isDuplicate(selectedModule, selectedSection)) {
      setLocalError("This permission already exists for this user.");
      return;
    }

    setLocalError(null);
    setIsSubmitting(true);

    try {
      await onAdd({
        module: selectedModule,
        section: selectedSection,
        mode: selectedMode,
      });
      // Reset form on success
      setSelectedModule("");
      setSelectedSection("");
      setSelectedMode("VIEW");
      onClose();
    } catch (err) {
      // Error handled by parent
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="
          relative w-full max-w-lg 
          bg-white dark:bg-gray-900 
          rounded-2xl shadow-2xl 
          border border-gray-200 dark:border-gray-700
          animate-in slide-in-from-bottom-4 duration-300
        "
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white font-poppins">
              Add Permission
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 font-poppins">
              Grant access to a specific module and section
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="
              p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 
              transition-all hover:scale-105 active:scale-95
              disabled:opacity-50 disabled:cursor-not-allowed
              focus:outline-none focus:ring-2 focus:ring-primary/50
            "
            aria-label="Close"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {/* Error */}
          {(localError || error) && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
              <AlertCircle className="w-4 h-4 text-red-500 dark:text-red-400 mt-0.5 shrink-0" />
              <span className="text-red-600 dark:text-red-400 text-sm font-poppins">
                {localError || error}
              </span>
            </div>
          )}

          {/* Module Select */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 font-poppins mb-1.5">
              Module <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <select
                value={selectedModule}
                onChange={(e) => {
                  setSelectedModule(e.target.value as Module | "");
                  setSelectedSection("");
                  setLocalError(null);
                }}
                className="
                  w-full h-12 px-4 pr-12 rounded-xl 
                  border border-gray-200 dark:border-gray-700
                  bg-white dark:bg-gray-800
                  text-sm font-poppins text-gray-900 dark:text-white
                  focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent
                  appearance-none cursor-pointer
                  transition-all hover:border-primary/30
                  disabled:opacity-50 disabled:cursor-not-allowed
                "
                disabled={isSubmitting || isLoading}
              >
                <option value="">Select a module...</option>
                {Object.entries(MODULES).map(([label, value]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center px-4 pointer-events-none">
                <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </div>
          </div>

          {/* Section Select */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 font-poppins mb-1.5">
              Section <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <select
                value={selectedSection}
                onChange={(e) => {
                  setSelectedSection(e.target.value);
                  setLocalError(null);
                }}
                className="
                  w-full h-12 px-4 pr-12 rounded-xl 
                  border border-gray-200 dark:border-gray-700
                  bg-white dark:bg-gray-800
                  text-sm font-poppins text-gray-900 dark:text-white
                  focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent
                  appearance-none cursor-pointer
                  transition-all hover:border-primary/30
                  disabled:opacity-50 disabled:cursor-not-allowed
                "
                disabled={!selectedModule || isSubmitting || isLoading}
              >
                <option value="">Select a section...</option>
                {availableSections.map((section) => (
                  <option key={section} value={section}>
                    {section.charAt(0).toUpperCase() + section.slice(1).replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center px-4 pointer-events-none">
                <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </div>
          </div>

          {/* Mode Select */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 font-poppins mb-1.5">
              Access Level <span className="text-red-500">*</span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setSelectedMode("VIEW")}
                className={`
                  h-12 rounded-xl border-2 font-poppins text-sm font-medium
                  transition-all hover:scale-[1.02] active:scale-[0.98]
                  focus:outline-none focus:ring-2 focus:ring-primary/50
                  ${selectedMode === "VIEW"
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300"
                    : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600"
                  }
                  disabled:opacity-50 disabled:cursor-not-allowed
                `}
                disabled={isSubmitting || isLoading}
              >
                👁️ View Only
              </button>
              <button
                type="button"
                onClick={() => setSelectedMode("EDIT")}
                className={`
                  h-12 rounded-xl border-2 font-poppins text-sm font-medium
                  transition-all hover:scale-[1.02] active:scale-[0.98]
                  focus:outline-none focus:ring-2 focus:ring-primary/50
                  ${selectedMode === "EDIT"
                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300"
                    : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600"
                  }
                  disabled:opacity-50 disabled:cursor-not-allowed
                `}
                disabled={isSubmitting || isLoading}
              >
                ✏️ Edit
              </button>
            </div>
          </div>

          {/* Duplicate warning */}
          {selectedModule && selectedSection && isDuplicate(selectedModule, selectedSection) && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
              <AlertCircle className="w-4 h-4 text-amber-500 dark:text-amber-400 mt-0.5 shrink-0" />
              <span className="text-amber-600 dark:text-amber-400 text-sm font-poppins">
                This permission already exists for this user.
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="
              px-6 h-11 rounded-xl
              border border-gray-200 dark:border-gray-700
              bg-white dark:bg-gray-800
              text-gray-700 dark:text-gray-300
              text-sm font-poppins font-medium
              hover:bg-gray-50 dark:hover:bg-gray-700
              transition-all hover:scale-[1.02] active:scale-[0.98]
              disabled:opacity-50 disabled:cursor-not-allowed
              focus:outline-none focus:ring-2 focus:ring-gray-300
            "
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={
              !selectedModule ||
              !selectedSection ||
              isSubmitting ||
              isLoading ||
              isDuplicate(selectedModule, selectedSection)
            }
            className="
              px-6 h-11 rounded-xl
              bg-primary hover:bg-primary/90
              text-white text-sm font-poppins font-medium
              flex items-center gap-2
              transition-all hover:scale-[1.02] active:scale-[0.98]
              disabled:opacity-50 disabled:cursor-not-allowed
              focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2
            "
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Add Permission
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}