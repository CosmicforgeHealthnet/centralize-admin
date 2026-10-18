"use client";

import React, { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import Image from "next/image";
import { useProfileStore } from "@/stores/profile.store";

const statusStyles: Record<string, string> = {
  IN_PROGRESS: "bg-yellow-50 text-yellow-500 border border-yellow-200",
  COMPLETED: "bg-green-50 text-green-500 border border-green-200",
  OVERDUE: "bg-red-50 text-red-400 border border-red-200",
};

const statusLabel: Record<string, string> = {
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  OVERDUE: "Overdue",
};

function formatDate(date?: string) {
  if (!date) return "—";

  return new Date(date).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default function ProjectDetail({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const {
    projectDetail,
    fetchMyProjectDetail,
    isLoadingProjectDetail,
  } = useProfileStore();

  useEffect(() => {
    fetchMyProjectDetail(projectId);
  }, [projectId]);

  if (isLoadingProjectDetail) {
    return (
      <div className="p-8">
        <div className="w-48 h-8 bg-muted rounded animate-pulse mb-6" />
        <div className="w-full h-64 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  if (!projectDetail) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">
          Project not found
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 sm:p-8">
      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-[13px] font-poppins text-foreground hover:opacity-70 transition-opacity w-fit"
      >
        <ArrowLeft size={16} />
        Go Back
      </button>

      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] font-poppins font-bold text-foreground">
          {projectDetail.title}
        </h1>

        <p className="text-[13px] font-poppins text-muted-foreground">
          Start Date: {formatDate(projectDetail.assignedDate)} — Due Date:{" "}
          {formatDate(projectDetail.dueDate)}
        </p>

        <span
          className={`text-[11px] font-poppins font-semibold px-3 py-1 rounded-full w-fit ${
            statusStyles[projectDetail.status]
          }`}
        >
          {statusLabel[projectDetail.status]}
        </span>
      </div>

      {/* Team Card */}
      <div className="border border-border rounded-[12px] p-5 flex flex-col gap-4">
        {/* Team */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] font-poppins font-semibold text-foreground">
              Team
            </p>

            <p className="text-[13px] font-poppins text-muted-foreground mt-0.5">
              {projectDetail.team}
            </p>
          </div>

          <div className="flex items-center">
            {projectDetail.members?.map((member, i) => (
              <div
                key={member.id}
                className={`relative w-9 h-9 rounded-full border-2 border-white overflow-hidden ${
                  i !== 0 ? "-ml-2" : ""
                }`}
              >
                <Image
                  src={member.avatarUrl || "/profile-img.png"}
                  alt={member.name}
                  fill
                  className="object-cover"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-border" />

        {/* Team Lead */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] font-poppins font-semibold text-foreground">
              Team Lead
            </p>

            <p className="text-[13px] font-poppins text-muted-foreground mt-0.5">
              {projectDetail.teamLead?.name || "—"}
            </p>
          </div>

          {projectDetail.teamLead && (
            <div className="relative w-9 h-9 rounded-full overflow-hidden border-2 border-white">
              <Image
                src={
                  projectDetail.teamLead.avatarUrl ||
                  "/profile-picture.png"
                }
                alt={projectDetail.teamLead.name}
                fill
                className="object-cover"
              />
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      <div className="border border-border rounded-[12px] p-5">
        <p className="text-[13px] font-poppins font-semibold text-foreground mb-3">
          Project Description
        </p>

        <p className="text-[13px] font-poppins text-foreground leading-relaxed">
          {projectDetail.description || "No description available."}
        </p>
      </div>
    </div>
  );
}