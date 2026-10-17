"use client";

import { useState } from "react";
import { Check, Eye, Pencil, X } from "lucide-react";
import { Module, MODULES, MODULE_SECTIONS, SectionGrantMode } from "@/types/hrm.types";

interface PermissionGridProps {
  grants: {
    module: Module;
    section: string;
    mode: SectionGrantMode;
  }[];
  onGrantChange?: (module: Module, section: string, mode: SectionGrantMode | null) => void;
  readOnly?: boolean;
  className?: string;
}

export default function PermissionGrid({
  grants,
  onGrantChange,
  readOnly = false,
  className = "",
}: PermissionGridProps) {
  const [hoveredCell, setHoveredCell] = useState<{ module: Module; section: string } | null>(null);

  const modules = Object.values(MODULES);
  const allSections = Array.from(
    new Set(Object.values(MODULE_SECTIONS).flat())
  );

  const getGrantMode = (module: Module, section: string): SectionGrantMode | null => {
    const grant = grants.find((g) => g.module === module && g.section === section);
    return grant ? grant.mode : null;
  };

  const getSectionsForModule = (module: Module): string[] => {
    return MODULE_SECTIONS[module] || [];
  };

  const handleToggle = (module: Module, section: string, mode: SectionGrantMode | null) => {
    if (readOnly || !onGrantChange) return;
    const current = getGrantMode(module, section);
    if (current === mode) {
      onGrantChange(module, section, null);
    } else {
      onGrantChange(module, section, mode);
    }
  };

  const getCellColor = (mode: SectionGrantMode | null) => {
    if (!mode) return "bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700/50";
    if (mode === "VIEW") return "bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-950/50";
    return "bg-emerald-50 dark:bg-emerald-950/30 hover:bg-emerald-100 dark:hover:bg-emerald-950/50";
  };

  const getCellBorder = (mode: SectionGrantMode | null, isHovered: boolean) => {
    if (isHovered && !readOnly) return "border-primary/40";
    if (!mode) return "border-transparent";
    if (mode === "VIEW") return "border-blue-200 dark:border-blue-800";
    return "border-emerald-200 dark:border-emerald-800";
  };

  const getCellIcon = (mode: SectionGrantMode | null) => {
    if (!mode) return null;
    if (mode === "VIEW") return <Eye className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />;
    return <Pencil className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />;
  };

  const getModeLabel = (mode: SectionGrantMode | null) => {
    if (!mode) return "—";
    return mode;
  };

  return (
    <div className={`w-full overflow-x-auto ${className}`}>
      <div className="min-w-[600px]">
        <div className="grid grid-cols-[120px_1fr] gap-0 border border-gray-200 dark:border-gray-700 rounded-t-xl overflow-hidden">
          <div className="bg-gray-50 dark:bg-gray-800 p-3 border-b border-r border-gray-200 dark:border-gray-700">
            <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 font-poppins uppercase tracking-wider">
              Module
            </span>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 p-3 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
            <div className="flex gap-1 min-w-max">
              {allSections.map((section) => (
                <div
                  key={section}
                  className="flex-1 min-w-[80px] text-center"
                >
                  <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400 font-poppins uppercase tracking-wider truncate block">
                    {section.replace(/_/g, " ")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="border-x border-b border-gray-200 dark:border-gray-700 rounded-b-xl overflow-hidden">
          {modules.map((module) => {
            const sections = getSectionsForModule(module);
            const moduleLabel = module.charAt(0).toUpperCase() + module.slice(1);

            return (
              <div
                key={module}
                className="grid grid-cols-[120px_1fr] gap-0 border-b border-gray-200 dark:border-gray-700 last:border-b-0 hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition-colors"
              >
                <div className="p-3 border-r border-gray-200 dark:border-gray-700 flex items-center">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300 font-poppins">
                    {moduleLabel}
                  </span>
                </div>

                <div className="p-1 overflow-x-auto">
                  <div className="flex gap-1 min-w-max">
                    {sections.map((section) => {
                      const mode = getGrantMode(module, section);
                      const isHovered = hoveredCell?.module === module && hoveredCell?.section === section;

                      return (
                        <div
                          key={section}
                          className={`
                            flex-1 min-w-[80px] p-1.5 rounded-lg
                            border-2 transition-all duration-200
                            ${getCellColor(mode)}
                            ${getCellBorder(mode, isHovered)}
                            ${!readOnly ? "cursor-pointer" : "cursor-default"}
                            ${!readOnly && !mode ? "hover:bg-gray-200/50 dark:hover:bg-gray-700/30" : ""}
                            ${!readOnly && mode ? "hover:scale-[1.02]" : ""}
                            ${readOnly ? "opacity-80" : ""}
                          `}
                          onMouseEnter={() => setHoveredCell({ module, section })}
                          onMouseLeave={() => setHoveredCell(null)}
                          onClick={() => {
                            if (readOnly || !onGrantChange) return;
                            if (mode === null) {
                              handleToggle(module, section, "VIEW");
                            } else if (mode === "VIEW") {
                              handleToggle(module, section, "EDIT");
                            } else {
                              handleToggle(module, section, null);
                            }
                          }}
                          role={!readOnly ? "button" : undefined}
                          tabIndex={!readOnly ? 0 : undefined}
                          aria-label={`${moduleLabel} / ${section} permission: ${getModeLabel(mode)}`}
                        >
                          <div className="flex flex-col items-center gap-1">
                            <div className="flex items-center justify-center w-6 h-6">
                              {getCellIcon(mode)}
                              {!mode && (
                                <X className="w-3 h-3 text-gray-300 dark:text-gray-600" />
                              )}
                            </div>
                            <span className={`
                              text-[8px] font-bold uppercase tracking-wider
                              ${mode === "VIEW" ? "text-blue-600 dark:text-blue-400" : ""}
                              ${mode === "EDIT" ? "text-emerald-600 dark:text-emerald-400" : ""}
                              ${!mode ? "text-gray-400 dark:text-gray-600" : ""}
                            `}>
                              {getModeLabel(mode)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}

          {modules.every((m) => getSectionsForModule(m).length === 0) && (
            <div className="p-8 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400 font-poppins">
                No modules available
              </p>
            </div>
          )}
        </div>

        {!readOnly && (
          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-gray-500 dark:text-gray-400 font-poppins">
            <span className="font-medium">Click to cycle:</span>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600" />
              <span>Off</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 flex items-center justify-center">
                <Eye className="w-2.5 h-2.5 text-blue-600 dark:text-blue-400" />
              </div>
              <span>View</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-300 dark:border-emerald-700 flex items-center justify-center">
                <Pencil className="w-2.5 h-2.5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <span>Edit</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}