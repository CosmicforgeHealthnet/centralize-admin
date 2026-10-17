const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const ACCESS_TOKEN_EXPIRY = "8h";
const REFRESH_TOKEN_EXPIRY = "7d";

const generateAccessToken = (payload) => {
  return jwt.sign(payload, process.env.ADMIN_JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    issuer: "cosmicforge-admin",
    audience: "cosmicforge-admin-client",
  });
};

const generateRefreshToken = () => {
  // Refresh token is a random UUID — not a JWT
  // Stored in DB, rotated on every use
  return uuidv4();
};

const verifyAccessToken = (token) => {
  return jwt.verify(token, process.env.ADMIN_JWT_SECRET, {
    issuer: "cosmicforge-admin",
    audience: "cosmicforge-admin-client",
  });
};

// Service token for calling the main health backend
// Uses the MAIN backend JWT secret so the main backend trusts it
const generateServiceToken = () => {
  return jwt.sign(
    {
      sub: "admin_service",
      role: "admin",
      type: "service_account",
    },
    process.env.MAIN_BACKEND_JWT_SECRET,
    { expiresIn: "1h", issuer: "cosmicforge-admin-service" },
  );
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  generateServiceToken,
};
