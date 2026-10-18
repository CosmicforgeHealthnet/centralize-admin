"use client";

import React, { useEffect } from "react";
import { useProfileStore } from "@/stores/profile.store";
import type { ProjectItem } from "@/types/profile.types";

const statusStyles: Record<string, string> = {
  IN_PROGRESS: "bg-[#FFF8E1] text-[#F59E0B] border border-[#FDE68A]",
  COMPLETED:   "bg-[#F0FDF4] text-[#22C55E] border border-[#BBF7D0]",
  OVERDUE:     "bg-[#FFF1F2] text-[#F87171] border border-[#FECACA]",
};

const statusLabel: Record<string, string> = {
  IN_PROGRESS: "In Progress",
  COMPLETED:   "Completed",
  OVERDUE:     "Overdue",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

export default function ProjectsList({
  onSelectProject,
}: {
  onSelectProject: (project: ProjectItem) => void;
}) {
  const { projects, isLoadingProjects, fetchMyProjects } = useProfileStore();

  useEffect(() => {
    fetchMyProjects();
  }, []);

  if (isLoadingProjects) {
    return (
      <div className="flex flex-col gap-4 p-6 sm:p-8">
        <div className="w-32 h-6 bg-muted rounded animate-pulse" />
        <div className="flex flex-col gap-3 mt-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="w-full h-12 bg-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 p-6">
        <img src="/no_data_found.png" alt="No projects" className="w-[120px] h-auto object-contain" />
        <p className="text-[13px] font-poppins text-muted-foreground">You are not part of any projects yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6 sm:p-8">
      <div>
        <h1 className="text-[24px] font-poppins font-bold text-foreground">Projects</h1>
        <p className="text-[13px] font-poppins text-muted-foreground mt-1">
          Here you have a list of Projects you are part of.
        </p>
      </div>

      <div className="overflow-x-auto scrollbar-none">
        <table className="w-full text-left border-collapse min-w-[800px]">
          <thead>
            <tr style={{ backgroundColor: "#E8EAF6" }}>
              {["Project Title", "Assigned Date", "Due Date", "Team", "Team Lead", "Members", "Status", "Action"].map((col, i) => (
                <th
                  key={col}
                  className={`px-4 py-3 text-[12px] font-poppins font-semibold text-foreground whitespace-nowrap ${
                    i === 0 ? "rounded-l-[8px]" : ""
                  } ${i === 7 ? "rounded-r-[8px]" : ""}`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} className="border-b border-border last:border-0">
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">{project.title}</td>
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">{formatDate(project.assignedDate)}</td>
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">{formatDate(project.dueDate)}</td>
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">{project.team}</td>
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">{project.teamLead}</td>
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">{project.members}</td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <span className={`text-[11px] font-poppins font-semibold px-3 py-1 rounded-full ${statusStyles[project.status]}`}>
                    {statusLabel[project.status]}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <button
                    onClick={() => onSelectProject(project)}
                    className="text-[18px] text-muted-foreground hover:text-foreground transition-colors leading-none tracking-widest"
                  >
                    •••
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}