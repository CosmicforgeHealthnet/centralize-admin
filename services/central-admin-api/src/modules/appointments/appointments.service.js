const mainApi = require("../../shared/config/mainApi");

class AppointmentsService {
  async getAllAppointments({ status, page, limit } = {}) {
    const params = {};
    if (status) params.status = status;
    if (page) params.page = page;
    if (limit) params.limit = limit;

    const response = await mainApi.get("/api/appointments", { params });
    return response.data;
  }

  async getAppointmentById(id) {
    const response = await mainApi.get(`/api/appointments/${id}`);
    return response.data;
  }

  async getAnalytics() {
    const response = await mainApi.get("/api/appointments/analytics");
    return response.data;
  }

  async getPatientAppointments(patientId) {
    const response = await mainApi.get(
      `/api/appointments/patient/${patientId}`,
    );
    return response.data;
  }

  async getDoctorAppointments(doctorId) {
    const response = await mainApi.get(`/api/appointments/doctor/${doctorId}`);
    return response.data;
  }

  async cancelAppointment(id, reason) {
    const response = await mainApi.patch(`/api/appointments/${id}/cancel`, {
      reason,
    });
    return response.data;
  }
}

module.exports = new AppointmentsService();
