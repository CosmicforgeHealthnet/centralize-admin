const mainApi = require("../../shared/config/mainApi");
const ApiError = require("../../shared/utils/ApiError");

class TicketsService {
  // tickets.service.js
  async getAllTickets({ status, issueType, priority, assignedTo }) {
    const params = {};
    if (status) params.status = status.toLowerCase();
    if (issueType) params.issueType = issueType;
    if (priority) params.priority = priority;
    if (assignedTo) params.assignedTo = assignedTo;

    const response = await mainApi.get("/api/support/account", { params });
    const tickets = response.data.data; // unwrap main backend data

    // clean before sending to frontend
    return tickets.map((ticket) => ({
      ...ticket,
      user: ticket.user
        ? {
            id: ticket.user.id,
            fullName: ticket.user.fullName,
            email: ticket.user.email,
            role: ticket.user.role,
            status: ticket.user.status,
            profileImageUrl: ticket.user.profileImageUrl,
            departmentSpecialty: ticket.user.departmentSpecialty,
            phoneNumber: ticket.user.phoneNumber,
            isOnline: ticket.user.isOnline,
          }
        : null,
    }));
  }
  async getTicketById(id) {
    const response = await mainApi.get(`/api/support/account/${id}`);
    return response.data;
  }

  async updateTicket(id, updateData) {
    const response = await mainApi.put(
      `/api/support/account/${id}`,
      updateData,
    );
    return response.data;
  }

  async assignTicket(id, assignedTo) {
    const response = await mainApi.post(`/api/support/account/${id}/assign`, {
      assignedTo,
    });
    return response.data;
  }

  async resolveTicket(id, resolutionNotes) {
    const response = await mainApi.post(`/api/support/account/${id}/resolve`, {
      resolutionNotes,
    });
    return response.data;
  }

  async getAllDisputes({ status, disputeType } = {}) {
    const params = {};
    if (status) params.status = status;
    if (disputeType) params.disputeType = disputeType;

    const response = await mainApi.get("/api/support/disputes", { params });
    return response.data;
  }

  async getDisputeById(id) {
    const response = await mainApi.get(`/api/support/disputes/${id}`);
    return response.data;
  }

  async updateDispute(id, updateData) {
    const response = await mainApi.put(
      `/api/support/disputes/${id}`,
      updateData,
    );
    return response.data;
  }
}

module.exports = new TicketsService();
