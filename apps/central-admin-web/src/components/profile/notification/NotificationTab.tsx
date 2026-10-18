"use client";

import React, { useEffect, useState } from "react";
import { AlertCircle, XCircle, Settings, Check, Bell, Trash2, CheckCheck } from "lucide-react";
import { useNotificationStore } from "@/stores/notification.store";
import { Button } from "@/components/ui/button";

type NotifIcon = "alert" | "xcircle" | "settings" | "check" | "bell";

function NotifIconBox({ type }: { type: NotifIcon }) {
  const iconProps = { size: 18, strokeWidth: 1.5, className: "text-[#6B7280]" };
  const iconMap: Record<NotifIcon, React.ReactNode> = {
    alert: <AlertCircle {...iconProps} />,
    xcircle: <XCircle {...iconProps} />,
    settings: <Settings {...iconProps} />,
    check: <Check {...iconProps} />,
    bell: <Bell {...iconProps} />,
  };

  return (
    <div
      className="w-9 h-9 rounded-[8px] flex items-center justify-center shrink-0"
      style={{ backgroundColor: "#F3F4F6" }}
    >
      {iconMap[type]}
    </div>
  );
}

export default function NotificationTab() {
  const {
    groupedNotifications,
    isLoading,
    isUpdating,
    fetchNotifications,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  } = useNotificationStore();

  const [selectedNotification, setSelectedNotification] = useState<string | null>(null);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const handleMarkAsRead = async (id: string) => {
    await markAsRead(id);
  };

  const handleMarkAllAsRead = async () => {
    await markAllAsRead();
  };

  const handleDelete = async (id: string) => {
    await deleteNotification(id);
    setSelectedNotification(null);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col p-6 sm:p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48"></div>
          <div className="h-4 bg-gray-200 rounded w-64"></div>
          <div className="space-y-3 mt-6">
            <div className="h-16 bg-gray-200 rounded"></div>
            <div className="h-16 bg-gray-200 rounded"></div>
            <div className="h-16 bg-gray-200 rounded"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col p-6 sm:p-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-4">
        <div>
          <h1 className="text-[24px] font-poppins font-bold text-foreground">Notifications</h1>
          <p className="text-[13px] font-poppins text-muted-foreground mt-1">
            Access your Notifications here
          </p>
        </div>

        {/* {groupedNotifications.length > 0 && (
          <Button
            onClick={handleMarkAllAsRead}
            disabled={isUpdating}
            variant="outline"
            size="sm"
            className="flex items-center gap-2"
          >
            <CheckCheck size={16} />
            Mark all as read
          </Button>
        )} */}
      </div>

      {groupedNotifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Bell size={48} className="text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-2">No notifications</h3>
          <p className="text-sm text-muted-foreground">You&apos;re all caught up! No new notifications to display.</p>
        </div>
      ) : (
        groupedNotifications.map((group) => (
          <div key={group.date} className="flex flex-col">
            <div className="flex items-center justify-center py-3">
              <span className="text-[12px] font-poppins text-muted-foreground bg-muted px-3 py-1 rounded-full">
                {group.date}
              </span>
            </div>

            {group.items.map((notif) => (
              <div
                key={notif.id}
                className={`flex items-start gap-3 py-3 cursor-pointer hover:bg-muted/30 rounded-[8px] px-2 -mx-2 transition-colors group ${
                  notif.unread ? "bg-muted/10" : ""
                }`}
                onClick={() => handleMarkAsRead(notif.id)}
              >
                <NotifIconBox type={notif.icon} />

                <div className="flex-1 min-w-0">
                  <p
                    className={`text-[13px] font-poppins text-foreground leading-snug ${
                      notif.bold ? "font-bold" : "font-normal"
                    }`}
                  >
                    {notif.title}
                  </p>
                  <p className="text-[12px] font-poppins text-muted-foreground leading-snug mt-0.5">
                    {notif.subtitle}
                  </p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex flex-col items-end gap-1">
                    {notif.unread && <div className="w-2 h-2 rounded-full bg-[#EF4444]" />}
                    <span className="text-[11px] font-poppins text-muted-foreground whitespace-nowrap">
                      {notif.time}
                    </span>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(notif.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-50 rounded-full"
                    disabled={isUpdating}
                  >
                    <Trash2 size={14} className="text-red-500" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}