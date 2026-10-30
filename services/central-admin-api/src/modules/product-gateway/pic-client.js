"use strict";

// Fixed-destination client for the Product Integration Core. The destination
// comes only from server configuration; no request data can change it.
// Bounded (5 s, 1 MiB), JSON only, redirects refused.

const http = require("node:http");
const ApiError = require("../../shared/utils/ApiError");

const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function gatewayError(status, code, message) {
  return new ApiError(status, message, [{ code, retryable: status === 503 }]);
}

function callPic(transport, { method, path, body, headers = {}, timeoutMs = TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const options = { method, path, headers: { ...headers }, agent: false };
    if (transport.kind === "unix") options.socketPath = transport.socketPath;
    else { options.host = transport.host; options.port = transport.port; }
    if (body && body.length) options.headers["Content-Length"] = String(body.length);

    let req;
    try {
      req = http.request(options, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return finish(reject, gatewayError(502, "PRODUCT_INTEGRATION_REDIRECT_REFUSED", "Product integration returned a redirect"));
        }
        if (!/^application\/json(?:;|$)/i.test(String(res.headers["content-type"] || ""))) {
          res.resume();
          return finish(reject, gatewayError(502, "PRODUCT_INTEGRATION_INVALID_RESPONSE", "Product integration returned an invalid response"));
        }
        if (Number(res.headers["content-length"] || 0) > maxResponseBytes) {
          res.destroy();
          return finish(reject, gatewayError(502, "PRODUCT_INTEGRATION_RESPONSE_TOO_LARGE", "Product integration response is too large"));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            res.destroy();
            finish(reject, gatewayError(502, "PRODUCT_INTEGRATION_RESPONSE_TOO_LARGE", "Product integration response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () => finish(reject, gatewayError(503, "PRODUCT_INTEGRATION_UNAVAILABLE", "Product integration is unavailable")));
        res.on("end", () => {
          try {
            finish(resolve, { status, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            finish(reject, gatewayError(502, "PRODUCT_INTEGRATION_INVALID_RESPONSE", "Product integration returned an invalid response"));
          }
        });
      });
    } catch {
      return finish(reject, gatewayError(503, "PRODUCT_INTEGRATION_UNAVAILABLE", "Product integration is unavailable"));
    }
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, gatewayError(503, "PRODUCT_INTEGRATION_UNAVAILABLE", "Product integration is unavailable"));
    }, timeoutMs);
    req.on("error", () => finish(reject, gatewayError(503, "PRODUCT_INTEGRATION_UNAVAILABLE", "Product integration is unavailable")));
    req.end(body && body.length ? body : undefined);
  });
}

module.exports = { callPic, TIMEOUT_MS, MAX_RESPONSE_BYTES };
