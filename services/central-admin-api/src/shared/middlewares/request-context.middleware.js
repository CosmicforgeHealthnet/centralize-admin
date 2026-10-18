const crypto = require("crypto");

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requestContext(req, res, next) {
  const inbound = String(req.get?.("x-request-id") || "").trim();
  const correlationId = SAFE_REQUEST_ID.test(inbound) ? inbound : crypto.randomUUID();
  req.correlationId = correlationId;
  res.locals.correlationId = correlationId;
  res.setHeader("X-Request-ID", correlationId);
  next();
}

module.exports = { SAFE_REQUEST_ID, requestContext };
