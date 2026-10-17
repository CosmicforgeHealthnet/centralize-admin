import api from "./api";
import type { ActivityLogsResponse } from "@/types/audit.types";

const BASE_URL = "/api/audit";

class AuditService {
  async getMyActivityLogs(page: number = 1, limit: number = 50): Promise<ActivityLogsResponse> {
    const response = await api.get(`${BASE_URL}/me`, {
      params: { page, limit },
    });
    return response.data.data;
  }

  async getAllActivityLogs(page: number = 1, limit: number = 50): Promise<ActivityLogsResponse> {
    const response = await api.get(`${BASE_URL}/all`, {
      params: { page, limit },
    });
    return response.data.data;
  }
}

export default new AuditService();