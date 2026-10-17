export type NotificationIcon = "alert" | "xcircle" | "settings" | "check" | "bell";

export interface Notification {
  id: string;
  icon: NotificationIcon;
  title: string;
  subtitle: string;
  time: string;
  unread: boolean;
  bold: boolean;
  createdAt?: string;
}

export interface NotificationGroup {
  date: string;
  items: Notification[];
}

export interface UnreadCountResponse {
  unreadCount: number;
}

export interface MarkAsReadResponse {
  id: string;
  isRead: boolean;
}

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}