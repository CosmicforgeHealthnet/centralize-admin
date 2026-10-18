"use client";

import React, { useState } from "react";
import ProjectsList from "./ProjectsList";
import ProjectDetail from "./ProjectDetail";
import type { ProjectItem } from "@/types/profile.types";

export default function ProjectsPage() {
  const [selectedProject, setSelectedProject] = useState<ProjectItem | null>(null);

  return (
    <div className="flex-1 min-w-0 bg-card border border-border rounded-[12px] overflow-hidden">
      {selectedProject ? (
        <ProjectDetail
          projectId={selectedProject.id}
          onBack={() => setSelectedProject(null)}
        />
      ) : (
        <ProjectsList onSelectProject={setSelectedProject} />
      )}
    </div>
  );
}