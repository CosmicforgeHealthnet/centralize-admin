import { create } from "zustand";
import notificationService from "@/lib/notification.service";
import type { Notification, NotificationGroup } from "@/types/notification.types";

interface NotificationState {
  notifications: Notification[];
  groupedNotifications: NotificationGroup[];
  unreadCount: number;
  isLoading: boolean;
  isUpdating: boolean;
  error: string | null;

  fetchNotifications: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  deleteNotification: (notificationId: string) => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

const groupNotificationsByDate = (notifications: Notification[]): NotificationGroup[] => {
  const groups: Record<string, Notification[]> = {};

  notifications.forEach((notification) => {
    const date = notification.time;
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(notification);
  });

  const orderMap: Record<string, number> = {
    "Just now": 0,
    "Today": 1,
    "Yesterday": 2,
  };

  return Object.entries(groups)
    .map(([date, items]) => ({ date, items }))
    .sort((a, b) => {
      const orderA = orderMap[a.date] ?? 3;
      const orderB = orderMap[b.date] ?? 3;
      if (orderA !== orderB) return orderA - orderB;
      return b.date.localeCompare(a.date);
    });
};

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  groupedNotifications: [],
  unreadCount: 0,
  isLoading: false,
  isUpdating: false,
  error: null,

  fetchNotifications: async () => {
    set({ isLoading: true, error: null });
    try {
      const notifications = await notificationService.getNotifications();
      const groupedNotifications = groupNotificationsByDate(notifications);
      set({
        notifications,
        groupedNotifications,
        isLoading: false,
      });
    } catch (error: any) {
      set({
        error: error.response?.data?.message || "Failed to fetch notifications",
        isLoading: false,
      });
    }
  },

  fetchUnreadCount: async () => {
    try {
      const unreadCount = await notificationService.getUnreadCount();
      set({ unreadCount });
    } catch (error: any) {
      console.error("Failed to fetch unread count:", error);
    }
  },

  markAsRead: async (notificationId: string) => {
    set({ isUpdating: true, error: null });
    try {
      await notificationService.markAsRead(notificationId);
      
      const updatedNotifications = get().notifications.map((notif) =>
        notif.id === notificationId
          ? { ...notif, unread: false, bold: false }
          : notif
      );
      
      const updatedGrouped = groupNotificationsByDate(updatedNotifications);
      const newUnreadCount = Math.max(0, get().unreadCount - 1);
      
      set({
        notifications: updatedNotifications,
        groupedNotifications: updatedGrouped,
        unreadCount: newUnreadCount,
        isUpdating: false,
      });
    } catch (error: any) {
      set({
        error: error.response?.data?.message || "Failed to mark notification as read",
        isUpdating: false,
      });
      throw error;
    }
  },

  markAllAsRead: async () => {
    set({ isUpdating: true, error: null });
    try {
      await notificationService.markAllAsRead();
      
      const updatedNotifications = get().notifications.map((notif) => ({
        ...notif,
        unread: false,
        bold: false,
      }));
      
      const updatedGrouped = groupNotificationsByDate(updatedNotifications);
      
      set({
        notifications: updatedNotifications,
        groupedNotifications: updatedGrouped,
        unreadCount: 0,
        isUpdating: false,
      });
    } catch (error: any) {
      set({
        error: error.response?.data?.message || "Failed to mark all notifications as read",
        isUpdating: false,
      });
      throw error;
    }
  },

  deleteNotification: async (notificationId: string) => {
    set({ isUpdating: true, error: null });
    try {
      await notificationService.deleteNotification(notificationId);
      
      const wasUnread = get().notifications.find((n) => n.id === notificationId)?.unread;
      const updatedNotifications = get().notifications.filter((notif) => notif.id !== notificationId);
      const updatedGrouped = groupNotificationsByDate(updatedNotifications);
      
      set({
        notifications: updatedNotifications,
        groupedNotifications: updatedGrouped,
        unreadCount: wasUnread ? Math.max(0, get().unreadCount - 1) : get().unreadCount,
        isUpdating: false,
      });
    } catch (error: any) {
      set({
        error: error.response?.data?.message || "Failed to delete notification",
        isUpdating: false,
      });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
  
  reset: () => {
    set({
      notifications: [],
      groupedNotifications: [],
      unreadCount: 0,
      isLoading: false,
      isUpdating: false,
      error: null,
    });
  },
}));