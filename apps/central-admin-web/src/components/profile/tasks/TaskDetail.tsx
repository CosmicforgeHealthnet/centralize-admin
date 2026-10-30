"use client";

import React, { useEffect } from "react";
import Image from "next/image";
import { ArrowLeft } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";

const statusStyles: Record<string, string> = {
  IN_PROGRESS: "bg-[#FFF8E1] text-[#F59E0B] border border-[#FDE68A]",
  COMPLETED: "bg-[#F0FDF4] text-[#22C55E] border border-[#BBF7D0]",
  OVERDUE: "bg-[#FFF1F2] text-[#F87171] border border-[#FECACA]",
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

export default function TaskDetail({
  taskId,
  onBack,
}: {
  taskId: string;
  onBack: () => void;
}) {
  const {
    taskDetail,
    fetchMyTaskDetail,
    isLoadingTaskDetail,
  } = useProfileStore();

  useEffect(() => {
    fetchMyTaskDetail(taskId);
  }, [taskId]);

  if (isLoadingTaskDetail) {
    return (
      <div className="p-8">
        <div className="w-48 h-8 bg-muted rounded animate-pulse mb-6" />
        <div className="w-full h-64 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  if (!taskDetail) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">Task not found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6 sm:p-8">

      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-[13px] font-poppins text-foreground hover:opacity-70 transition-opacity w-fit"
      >
        <ArrowLeft size={16} />
        Go Back
      </button>

      {/* Title */}
      <h1 className="text-[26px] font-poppins font-bold text-foreground">
        {taskDetail.title}
      </h1>

      {/* Dates */}
      <p className="text-[13px] font-poppins text-muted-foreground">
        Assigned Date: {formatDate(taskDetail.assignedDate)} · Due Date:{" "}
        {formatDate(taskDetail.dueDate)}
      </p>

      {/* Status */}
      <span
        className={`text-[11px] font-poppins font-semibold px-3 py-1.5 rounded-full w-fit ${
          statusStyles[taskDetail.status]
        }`}
      >
        {statusLabel[taskDetail.status]}
      </span>

      {/* Assigner */}
      <div className="border border-border rounded-[12px] px-5 py-4 flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-[12px] font-poppins font-semibold text-foreground">
            Assigner
          </span>

          <span className="text-[13px] font-poppins text-foreground mt-1">
            {taskDetail.assigner?.name}
          </span>
        </div>

        <div className="w-10 h-10 rounded-full overflow-hidden">
          <Image
            src={taskDetail.assigner?.avatarUrl || "/profile-img.png"}
            alt="assigner"
            width={40}
            height={40}
            className="w-full h-full object-cover"
          />
        </div>
      </div>

      {/* Description */}
      <div className="border border-border rounded-[12px] px-5 py-4 flex flex-col gap-3">
        <span className="text-[12px] font-poppins font-semibold text-foreground">
          Task Description
        </span>

        <p className="text-[13px] font-poppins text-foreground leading-relaxed whitespace-pre-line">
          {taskDetail.description || "No description available."}
        </p>
      </div>

    </div>
  );
}