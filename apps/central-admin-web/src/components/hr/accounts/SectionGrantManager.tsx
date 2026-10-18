"use client";

import { useState, useEffect, useCallback } from "react";
import { X, Plus, Save, AlertCircle, Loader2 } from "lucide-react";
import { useHrmStore } from "@/stores/hrm.store";
import {
  MODULES,
  MODULE_SECTIONS,
  Module,
  SectionGrantMode,
  CreateSectionGrantPayload,
  SectionGrant,
} from "@/types/hrm.types";
import PermissionChip from "./PermissionChip";

interface SectionGrantManagerProps {
  userId: string;
  userName?: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function SectionGrantManager({
  userId,
  userName,
  onClose,
  onSuccess,
}: SectionGrantManagerProps) {
  const {
    sectionGrants,
    isLoadingGrants,
    grantsError,
    fetchUserGrants,
    addUserGrant,
    removeUserGrant,
    syncUserGrants,
    clearGrants,
  } = useHrmStore();

  const [selectedModule, setSelectedModule] = useState<Module | "">("");
  const [selectedSection, setSelectedSection] = useState<string>("");
  const [selectedMode, setSelectedMode] = useState<SectionGrantMode>("VIEW");
  const [isAdding, setIsAdding] = useState(false);
  const [localGrants, setLocalGrants] = useState<SectionGrant[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    fetchUserGrants(userId);
    return () => clearGrants();
  }, [userId, fetchUserGrants, clearGrants]);

  useEffect(() => {
    if (Array.isArray(sectionGrants)) {
      setLocalGrants(sectionGrants);
    }
  }, [sectionGrants]);

  const availableSections = selectedModule ? MODULE_SECTIONS[selectedModule] || [] : [];

  const isGrantDuplicate = useCallback(
    (module: Module, section: string) => {
      return localGrants.some((g) => g.module === module && g.section === section);
    },
    [localGrants]
  );

  const handleAddGrant = async () => {
    if (!selectedModule || !selectedSection) {
      setLocalError("Please select both a module and a section.");
      return;
    }

    if (isGrantDuplicate(selectedModule, selectedSection)) {
      setLocalError("This permission already exists.");
      return;
    }

    setIsAdding(true);
    setLocalError(null);

    try {
      const grant = await addUserGrant(userId, {
        module: selectedModule,
        section: selectedSection,
        mode: selectedMode,
      });

      if (grant && grant.id) {
        setLocalGrants((prev) => {
          const exists = prev.some((g) => g.id === grant.id);
          if (exists) return prev;
          return [...prev, grant];
        });

        setSelectedModule("");
        setSelectedSection("");
        setSelectedMode("VIEW");
        setSuccessMessage("Permission added successfully!");
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        await fetchUserGrants(userId);
        setSuccessMessage("Permission added successfully!");
        setTimeout(() => setSuccessMessage(null), 3000);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to add permission";
      setLocalError(errorMsg);
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveGrant = async (grantId: string) => {
    if (!grantId) return;

    try {
      await removeUserGrant(grantId);
      setLocalGrants((prev) => prev.filter((g) => g.id !== grantId));
      setSuccessMessage("Permission removed successfully!");
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      // Error handled by store
    }
  };

  const handleSave = async () => {
    setIsSaving(true);

    try {
      const validGrants = localGrants.filter((g) => g && g.id);
      const grantsToSync: CreateSectionGrantPayload[] = validGrants.map((g) => ({
        module: g.module,
        section: g.section,
        mode: g.mode,
      }));

      await syncUserGrants(userId, grantsToSync);
      setSuccessMessage("All permissions saved successfully!");
      setTimeout(() => setSuccessMessage(null), 3000);
      onSuccess?.();
    } catch (err) {
      // Error handled by store
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    if (isSaving || isAdding) return;
    onClose();
  };

  const displayError = localError || grantsError;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl max-h-[90vh] bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col animate-in slide-in-from-bottom-4 duration-300">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white font-poppins">
              Manage Permissions
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 font-poppins mt-0.5 truncate">
              {userName ? `Managing permissions for ${userName}` : "Managing user permissions"}
            </p>
          </div>
          <button
            onClick={handleClose}
            disabled={isSaving || isAdding}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-all hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary/50"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {successMessage && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 animate-in slide-in-from-top-1 duration-200">
              <span className="text-emerald-600 dark:text-emerald-400 text-sm font-poppins">
                {successMessage}
              </span>
            </div>
          )}

          {displayError && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
              <AlertCircle className="w-4 h-4 text-red-500 dark:text-red-400 mt-0.5 shrink-0" />
              <span className="text-red-600 dark:text-red-400 text-sm font-poppins">
                {displayError}
              </span>
            </div>
          )}

          <div className="space-y-3">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 font-poppins">
              Add New Permission
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="relative">
                <select
                  value={selectedModule}
                  onChange={(e) => {
                    setSelectedModule(e.target.value as Module | "");
                    setSelectedSection("");
                    setLocalError(null);
                  }}
                  className="w-full h-11 px-3 pr-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-poppins text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent appearance-none cursor-pointer transition-all hover:border-primary/30 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isLoadingGrants || isAdding}
                >
                  <option value="">Select Module</option>
                  {Object.entries(MODULES).map(([label, value]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <div className="absolute inset-y-0 right-0 flex items-center px-3 pointer-events-none">
                  <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </div>

              <div className="relative">
                <select
                  value={selectedSection}
                  onChange={(e) => {
                    setSelectedSection(e.target.value);
                    setLocalError(null);
                  }}
                  className="w-full h-11 px-3 pr-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-poppins text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent appearance-none cursor-pointer transition-all hover:border-primary/30 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!selectedModule || isLoadingGrants || isAdding}
                >
                  <option value="">Select Section</option>
                  {availableSections.map((section) => (
                    <option key={section} value={section}>
                      {section.charAt(0).toUpperCase() + section.slice(1)}
                    </option>
                  ))}
                </select>
                <div className="absolute inset-y-0 right-0 flex items-center px-3 pointer-events-none">
                  <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </div>

              <div className="relative">
                <select
                  value={selectedMode}
                  onChange={(e) => setSelectedMode(e.target.value as SectionGrantMode)}
                  className="w-full h-11 px-3 pr-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-poppins text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent appearance-none cursor-pointer transition-all hover:border-primary/30 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!selectedModule || isLoadingGrants || isAdding}
                >
                  <option value="VIEW">View Only</option>
                  <option value="EDIT">Edit</option>
                </select>
                <div className="absolute inset-y-0 right-0 flex items-center px-3 pointer-events-none">
                  <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </div>

              <button
                onClick={handleAddGrant}
                disabled={
                  !selectedModule ||
                  !selectedSection ||
                  isAdding ||
                  isLoadingGrants ||
                  isGrantDuplicate(selectedModule, selectedSection)
                }
                className="h-11 px-4 rounded-xl bg-primary hover:bg-primary/90 text-white text-sm font-poppins font-medium flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2"
              >
                {isAdding ? (
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

            {selectedModule && selectedSection && isGrantDuplicate(selectedModule, selectedSection) && (
              <p className="text-xs text-amber-600 dark:text-amber-400 font-poppins">
                This permission already exists for this user.
              </p>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 font-poppins">
                Current Permissions
                <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                  ({Array.isArray(localGrants) ? localGrants.length : 0})
                </span>
              </h3>
              {Array.isArray(localGrants) && localGrants.length > 0 && (
                <button
                  onClick={() => setLocalGrants([])}
                  disabled={isSaving}
                  className="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 font-poppins font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Remove All
                </button>
              )}
            </div>

            {isLoadingGrants ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
                <p className="text-sm text-gray-500 dark:text-gray-400 font-poppins">
                  Loading permissions...
                </p>
              </div>
            ) : !Array.isArray(localGrants) || localGrants.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-3">
                  <span className="text-2xl">🔒</span>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 font-poppins">
                  No permissions assigned yet.
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 font-poppins mt-1">
                  Use the form above to add module and section permissions.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 p-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 min-h-[60px] transition-all">
                {localGrants
                  .filter((grant) => grant && grant.id && grant.module && grant.section)
                  .map((grant, index) => (
                    <PermissionChip
                      key={`${grant.id}-${index}`}
                      module={grant.module}
                      section={grant.section}
                      mode={grant.mode}
                      onRemove={() => handleRemoveGrant(grant.id)}
                      size="md"
                    />
                  ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 dark:border-gray-700 shrink-0">
          <button
            onClick={handleClose}
            disabled={isSaving || isAdding}
            className="px-6 h-11 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-poppins font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-300"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || isLoadingGrants}
            className="px-6 h-11 rounded-xl bg-primary hover:bg-primary/90 text-white text-sm font-poppins font-medium flex items-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Changes
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}