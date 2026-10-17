import api from "./api";
import type { Notification, UnreadCountResponse, MarkAsReadResponse, ApiResponse } from "@/types/notification.types";

const BASE_URL = "/api/notifications";

class NotificationService {
  async getNotifications(): Promise<Notification[]> {
    const response = await api.get<ApiResponse<Notification[]>>(BASE_URL);
    return response.data.data;
  }

  async getUnreadCount(): Promise<number> {
    const response = await api.get<ApiResponse<UnreadCountResponse>>(`${BASE_URL}/unread-count`);
    return response.data.data.unreadCount;
  }

  async markAsRead(notificationId: string): Promise<MarkAsReadResponse> {
    const response = await api.patch<ApiResponse<MarkAsReadResponse>>(`${BASE_URL}/${notificationId}/read`);
    return response.data.data;
  }

  async markAllAsRead(): Promise<{ message: string; count: number }> {
    const response = await api.patch<ApiResponse<{ message: string; count: number }>>(`${BASE_URL}/mark-all-read`);
    return response.data.data;
  }

  async deleteNotification(notificationId: string): Promise<{ message: string }> {
    const response = await api.delete<ApiResponse<{ message: string }>>(`${BASE_URL}/${notificationId}`);
    return response.data.data;
  }
}

export default new NotificationService();