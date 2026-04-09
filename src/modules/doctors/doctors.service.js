const mainApi = require("../../shared/config/mainApi");

class DoctorsService {
  async getAllDoctors() {
    const response = await mainApi.get("/api/doctor/list");
    return response.data;
  }

  async getVerifiedDoctors() {
    const response = await mainApi.get("/api/doctor/list/verified");
    return response.data;
  }

  async getOnlineDoctors() {
    const response = await mainApi.get("/api/doctor/list/online?isOnline=true");
    return response.data;
  }

  async getDoctorById(userId) {
    const response = await mainApi.get(`/api/doctor/${userId}`);
    return response.data;
  }

  async searchDoctors(query) {
    const response = await mainApi.get("/api/doctor/search", {
      params: { q: query },
    });
    return response.data;
  }

  // Powers StatCards — returns counts for dashboard
  async getDoctorStats() {
    const [all, verified, online] = await Promise.allSettled([
      mainApi.get("/api/doctor/list"),
      mainApi.get("/api/doctor/list/verified"),
      mainApi.get("/api/doctor/list/online?isOnline=true"),
    ]);

    const extract = (result) =>
      result.status === "fulfilled"
        ? result.value.data.data || result.value.data || []
        : [];

    const allDoctors = extract(all);
    const verifiedDoctors = extract(verified);
    const onlineDoctors = extract(online);

    return {
      total: allDoctors.length,
      verified: verifiedDoctors.length,
      online: onlineDoctors.length,
    };
  }
}

module.exports = new DoctorsService();
