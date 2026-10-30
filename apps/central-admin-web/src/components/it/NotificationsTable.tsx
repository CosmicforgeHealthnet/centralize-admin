"use client";

import { useState } from "react";
import { useITStore } from "@/stores/it.store";
import {
  SkeletonRow,
  TablePagination,
  ErrorBanner,
  formatDate,
} from "./table.utils";

const TYPE_STYLE: Record<string, { bg: string; text: string }> = {
  consultation: { bg: "rgba(39,46,167,0.10)",  text: "#272EA7" },
  rtc:          { bg: "rgba(13,165,63,0.12)",  text: "#0DA53F" },
  prescription: { bg: "rgba(232,182,0,0.12)",  text: "#E8B600" },
  delivery:     { bg: "rgba(232,182,0,0.12)",  text: "#E8B600" },
  payment:      { bg: "rgba(13,165,63,0.12)",  text: "#0DA53F" },
};

export default function NotificationsTable() {
  const notifications     = useITStore((s) => s.notifications);
  const pagination        = useITStore((s) => s.notificationPagination);
  const filters           = useITStore((s) => s.notificationFilters);
  const isLoading         = useITStore((s) => s.isLoadingNotifications);
  const error             = useITStore((s) => s.error);
  const setFilters        = useITStore((s) => s.setNotificationFilters);
  const fetchNotifications = useITStore((s) => s.fetchUserNotifications);
  const clearError        = useITStore((s) => s.clearError);

  const [userId, setUserId]         = useState("");
  const [userIdDraft, setUserIdDraft] = useState("");

  const handleSearch = () => {
    if (!userIdDraft.trim()) return;
    setUserId(userIdDraft.trim());
    setFilters({ page: 1 });
    fetchNotifications(userIdDraft.trim());
  };

  const currentPage = pagination?.currentPage ?? 1;
  const totalPages  = pagination?.totalPages ?? 1;
  const totalItems  = pagination?.totalItems ?? 0;

  const HEADERS = ["Type", "Title", "Message", "Read", "Sent At"];

  return (
    <div className="bg-card rounded-xl border border-border flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <h2 className="text-[15px] font-poppins font-semibold text-foreground">
          User Notifications
          {pagination && userId && (
            <span className="ml-2 text-[12px] font-normal text-muted-foreground">({totalItems} total)</span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 h-[36px] flex-1 sm:w-[260px] sm:flex-none">
            <input
              type="text"
              placeholder="Enter User ID..."
              value={userIdDraft}
              onChange={(e) => setUserIdDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="bg-transparent text-[12px] font-poppins text-foreground outline-none w-full placeholder:text-muted-foreground"
            />
          </div>
          <button
            onClick={handleSearch}
            className="h-[36px] px-5 bg-primary text-white text-[13px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
          >
            Load
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-border">
              {HEADERS.map((h) => (
                <th key={h} className="text-left py-2.5 px-4 sm:px-5 text-[12px] font-poppins font-semibold text-muted-foreground whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!userId ? (
              <tr>
                <td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  Enter a User ID to view their notifications
                </td>
              </tr>
            ) : isLoading ? (
              Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={HEADERS.length} />)
            ) : notifications.length === 0 ? (
              <tr>
                <td colSpan={HEADERS.length} className="text-center py-14 text-[13px] font-poppins text-muted-foreground">
                  No notifications found for this user
                </td>
              </tr>
            ) : (
              notifications.map((row) => {
                const style = TYPE_STYLE[row.type] ?? { bg: "rgba(143,144,164,0.15)", text: "#8F90A4" };
                return (
                  <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="py-3 px-4 sm:px-5">
                      <span
                        className="inline-flex items-center px-3 py-1 rounded-full text-[12px] font-poppins font-semibold whitespace-nowrap capitalize"
                        style={{ backgroundColor: style.bg, color: style.text }}
                      >
                        {row.type}
                      </span>
                    </td>
                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins font-semibold text-foreground">
                      {row.title}
                    </td>
                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground max-w-[280px]">
                      {row.message}
                    </td>
                    <td className="py-3 px-4 sm:px-5">
                      <span
                        className={`inline-flex items-center px-3 py-1 rounded-full text-[12px] font-poppins font-semibold ${
                          row.isRead
                            ? "bg-muted text-muted-foreground"
                            : "bg-primary/10 text-primary"
                        }`}
                      >
                        {row.isRead ? "Read" : "Unread"}
                      </span>
                    </td>
                    <td className="py-3 px-4 sm:px-5 text-[13px] font-poppins text-foreground whitespace-nowrap">
                      {formatDate(row.createdAt)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {userId && (
        <TablePagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={(p) => { setFilters({ page: p }); fetchNotifications(userId); }}
        />
      )}
    </div>
  );
}