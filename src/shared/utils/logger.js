const { createLogger, format, transports } = require("winston");
const path = require("path");
const {
  redactLogPayload,
} = require("../../modules/marketing/social-operations/security/log-redaction.service");

const { combine, timestamp, printf, colorize, errors } = format;

const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`;
});

const logger = createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: combine(
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    errors({ stack: true }),
    logFormat,
  ),
  transports: [
    new transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        errors({ stack: true }),
        logFormat,
      ),
    }),
  ],
});

// Mask sensitive fields from logs
logger.maskSensitive = (obj) => {
  return redactLogPayload(obj);
};

module.exports = logger;
