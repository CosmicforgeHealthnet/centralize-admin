const mainApi = require("../../shared/config/mainApi");

class PaymentsService {
  async getStatistics() {
    const response = await mainApi.get("/api/payments/statistics");
    return response.data;
  }

  async getDashboardAnalytics() {
    const response = await mainApi.get("/api/payments/analytics/dashboard");
    return response.data;
  }

  async getServiceAnalytics(serviceType) {
    const params = serviceType ? { serviceType } : {};
    const response = await mainApi.get("/api/payments/analytics/services", {
      params,
    });
    return response.data;
  }

  async getCurrencyAnalytics() {
    const response = await mainApi.get("/api/payments/analytics/currency");
    return response.data;
  }

  async getProviderPerformance() {
    const response = await mainApi.get(
      "/api/payments/analytics/provider-performance",
    );
    return response.data;
  }

  async getTransactionById(id) {
    const response = await mainApi.get(`/api/transactions/${id}`);
    return response.data;
  }

  async getUserTransactions(userId) {
    const response = await mainApi.get(`/api/transactions`, {
      params: { userId },
    });
    return response.data;
  }

  async getCancelledTransactions() {
    const response = await mainApi.get("/api/payments/cancelled");
    return response.data;
  }

  async processManualRefund(transactionId, { reason, refundAmount }) {
    const response = await mainApi.post(
      `/api/payments/${transactionId}/refund`,
      {
        reason,
        refundAmount,
      },
    );
    return response.data;
  }
}

module.exports = new PaymentsService();
