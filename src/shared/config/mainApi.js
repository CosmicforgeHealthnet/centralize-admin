const axios = require("axios");
const { generateServiceToken } = require("../utils/jwt.util");
const logger = require("../utils/logger");

// Create an axios instance that always sends a fresh service token
const createMainApiClient = () => {
  const client = axios.create({
    baseURL: process.env.MAIN_BACKEND_URL,
    timeout: 15000,
    headers: { "Content-Type": "application/json" },
  });

  // Attach a fresh service token before every request
  client.interceptors.request.use((config) => {
    const serviceToken = generateServiceToken();
    config.headers.Authorization = `Bearer ${serviceToken}`;
    return config;
  });

  // Log errors from main backend without exposing internals
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;
      logger.error(`Main backend error [${status}]: ${message}`);
      return Promise.reject(error);
    },
  );

  return client;
};

const mainApi = createMainApiClient();

module.exports = mainApi;
