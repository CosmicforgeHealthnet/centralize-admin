"use client";

import React, { useEffect } from "react";
import { useProfileStore } from "@/stores/profile.store";
import type { TaskItem } from "@/types/profile.types";

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

export default function TasksList({
  onSelectTask,
}: {
  onSelectTask: (task: TaskItem) => void;
}) {
  const { tasks, fetchMyTasks, isLoadingTasks } = useProfileStore();

  useEffect(() => {
    fetchMyTasks();
  }, []);

  if (isLoadingTasks) {
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

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 p-6">
        <p className="text-[13px] font-poppins text-muted-foreground">
          No tasks assigned yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6 sm:p-8">
      <div>
        <h1 className="text-[24px] font-poppins font-bold text-foreground">Tasks</h1>
        <p className="text-[13px] font-poppins text-muted-foreground mt-1">
          Here you have a list of Tasks you are assigned to
        </p>
      </div>

      <div className="overflow-x-auto scrollbar-none">
        <table className="w-full text-left border-collapse min-w-[700px]">
          <thead>
            <tr style={{ backgroundColor: "#E8EAF6" }}>
              {["Task", "Assigned Date", "Due Date", "Assigner", "Status", "Action"].map((col, i) => (
                <th
                  key={col}
                  className={`px-4 py-3 text-[12px] font-poppins font-semibold text-foreground whitespace-nowrap ${
                    i === 0 ? "rounded-l-[8px]" : ""
                  } ${i === 5 ? "rounded-r-[8px]" : ""}`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {tasks.map((task) => (
              <tr key={task.id} className="border-b border-border last:border-0">
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">
                  {task.title}
                </td>
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">
                  {formatDate(task.assignedDate)}
                </td>
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">
                  {formatDate(task.dueDate)}
                </td>
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground whitespace-nowrap">
                  {task.assigner}
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <span
                    className={`text-[11px] font-poppins font-semibold px-3 py-1 rounded-full ${
                      statusStyles[task.status]
                    }`}
                  >
                    {statusLabel[task.status]}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <button
                    onClick={() => onSelectTask(task)}
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