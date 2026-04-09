const mainApi = require("../../shared/config/mainApi");
const ApiError = require("../../shared/utils/ApiError");

class TicketsService {
  // ── Helper ────────────────────────────────────────────
  _cleanTicket(ticket) {
    return {
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
    };
  }

  // ── Account Tickets ───────────────────────────────────
  async getAllTickets({ status, issueType, priority, assignedTo } = {}) {
    const params = {};
    if (status) params.status = status.toLowerCase();
    if (issueType) params.issueType = issueType;
    if (priority) params.priority = priority;
    if (assignedTo) params.assignedTo = assignedTo;

    const response = await mainApi.get("/api/support/account", { params });
    const tickets = response.data.data;
    return tickets.map(this._cleanTicket);
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

  // ── Disputes ──────────────────────────────────────────
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

  // ── Insurance ─────────────────────────────────────────
  async getAllInsuranceTickets({ status } = {}) {
    const params = {};
    if (status) params.status = status;

    const response = await mainApi.get("/api/support/insurance", { params });
    return response.data;
  }

  async getInsuranceTicketById(id) {
    const response = await mainApi.get(`/api/support/insurance/${id}`);
    return response.data;
  }

  async updateInsuranceTicket(id, updateData) {
    const response = await mainApi.put(
      `/api/support/insurance/${id}`,
      updateData,
    );
    return response.data;
  }

  // ── Reports ───────────────────────────────────────────
  async getAllReports({ status } = {}) {
    const params = {};
    if (status) params.status = status;

    const response = await mainApi.get("/api/support/reports", { params });
    return response.data;
  }

  async getReportById(id) {
    const response = await mainApi.get(`/api/support/reports/${id}`);
    return response.data;
  }

  async updateReport(id, updateData) {
    const response = await mainApi.put(
      `/api/support/reports/${id}`,
      updateData,
    );
    return response.data;
  }

  // ── Stats Aggregator ──────────────────────────────────
  // Powers: HelpStatCards + TicketTypeChart in one call
  async getSupportStats({ status } = {}) {
    const [accounts, disputes, insurance, reports] = await Promise.allSettled([
      mainApi.get("/api/support/account"),
      mainApi.get("/api/support/disputes"),
      mainApi.get("/api/support/insurance"),
      mainApi.get("/api/support/reports"),
    ]);

    const extract = (result) =>
      result.status === "fulfilled" ? result.value.data.data || [] : [];

    const accountTickets = extract(accounts);
    const disputeTickets = extract(disputes);
    const insuranceTickets = extract(insurance);
    const reportTickets = extract(reports);

    const allTickets = [
      ...accountTickets,
      ...disputeTickets,
      ...insuranceTickets,
      ...reportTickets,
    ];

    const resolvedStatuses = ["resolved", "closed"];
    const unresolvedStatuses = ["pending", "open", "in_progress", "failed"];

    return {
      // HelpStatCards
      total: allTickets.length,
      resolved: allTickets.filter((t) =>
        resolvedStatuses.includes(t.status?.toLowerCase()),
      ).length,
      unresolved: allTickets.filter((t) =>
        unresolvedStatuses.includes(t.status?.toLowerCase()),
      ).length,

      // TicketTypeChart
      byType: {
        account: accountTickets.length,
        dispute: disputeTickets.length,
        insurance: insuranceTickets.length,
        report: reportTickets.length,
      },
    };
  }

  // ── All Tickets Merged ────────────────────────────────
  // Powers: RecentTickets table (merged, sorted by date)
  async getAllTicketsMerged({ status, type } = {}) {
    const sources = {
      account: () =>
        mainApi.get("/api/support/account", {
          params: status ? { status } : {},
        }),
      dispute: () =>
        mainApi.get("/api/support/disputes", {
          params: status ? { status } : {},
        }),
      insurance: () =>
        mainApi.get("/api/support/insurance", {
          params: status ? { status } : {},
        }),
      report: () =>
        mainApi.get("/api/support/reports", {
          params: status ? { status } : {},
        }),
    };

    // If type filter is applied, only fetch that type
    const keys = type && sources[type] ? [type] : Object.keys(sources);

    const results = await Promise.allSettled(keys.map((k) => sources[k]()));

    const merged = [];
    keys.forEach((key, i) => {
      if (results[i].status === "fulfilled") {
        const tickets = results[i].value.data.data || [];
        tickets.forEach((ticket) => {
          merged.push({
            ...this._cleanTicket(ticket),
            ticketCategory: key, // account | dispute | insurance | report
          });
        });
      }
    });

    // Sort by createdAt descending (most recent first)
    merged.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return merged;
  }
}

module.exports = new TicketsService();
