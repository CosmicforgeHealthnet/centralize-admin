"use strict";

// §17.1: deliberate, route-specific request limits for the Mail API instead
// of one large JSON limit. The global Admin parser stays at 10 KB.
//
//   raw webhooks / product events   256 KB raw (signature over exact bytes; app.js)
//   rich bodies (drafts, signatures, marketing templates/campaigns/automations)
//                                   MAIL_BODY_MAX_BYTES (escaped JSON overhead
//                                   included), at most 12 MB
//   every other Mail route          64 KB
//   attachments / CSV               multipart with their own multer limits
//
// After parsing, every Mail JSON body is shape-checked (nesting depth, array
// length, key count, string length) so a small but hostile body cannot
// exhaust memory or CPU in validators further down.

const express = require("express");

const SMALL_LIMIT = 64 * 1024;
const MAX_RICH_LIMIT = 12 * 1024 * 1024;

// Paths are relative to /api/mail/v1.
const RICH_BODY_ROUTES = [
  { method: "POST", pattern: /^\/mailboxes\/[^/]+\/drafts$/ },
  { method: "PATCH", pattern: /^\/drafts\/[^/]+$/ },
  { method: "PUT", pattern: /^\/me\/preferences$/ },
  { method: "PATCH", pattern: /^\/mailboxes\/[^/]+\/settings$/ },
  // Marketing authoring: template versions / render / QA, campaigns, automations, test sends.
  { method: "*", pattern: /^\/marketing\/[^/]+\/(templates|campaigns|automations|test-sends?)(\/|$)/ },
];

const SHAPE = Object.freeze({ maxDepth: 16, maxArrayLength: 5000, maxKeys: 20000, maxStringLength: 12 * 1024 * 1024 });

function richLimitBytes(bodyMaxBytes) {
  // JSON escaping can roughly double HTML size; add headroom for the
  // surrounding fields. Bounded so a misconfiguration cannot open the API.
  const value = Number(bodyMaxBytes) || 1024 * 1024;
  return Math.min(Math.max(value * 2 + 64 * 1024, 256 * 1024), MAX_RICH_LIMIT);
}

function isRichBodyRoute(method, relativePath) {
  return RICH_BODY_ROUTES.some((route) => (route.method === "*" || route.method === method) && route.pattern.test(relativePath));
}

// Returns null when the value is acceptable, otherwise a reason code.
function jsonShapeProblem(value, limits = SHAPE) {
  let keys = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (typeof node === "string") {
      if (node.length > limits.maxStringLength) return "STRING_TOO_LONG";
      continue;
    }
    if (!node || typeof node !== "object") continue;
    if (depth > limits.maxDepth) return "TOO_DEEP";
    if (Array.isArray(node)) {
      if (node.length > limits.maxArrayLength) return "ARRAY_TOO_LONG";
      for (const item of node) stack.push([item, depth + 1]);
      continue;
    }
    const entries = Object.keys(node);
    keys += entries.length;
    if (keys > limits.maxKeys) return "TOO_MANY_KEYS";
    for (const key of entries) stack.push([node[key], depth + 1]);
  }
  return null;
}

function createMailJsonParsing({ bodyMaxBytes, prefix = "/api/mail/v1" }) {
  const small = express.json({ limit: SMALL_LIMIT });
  const rich = express.json({ limit: richLimitBytes(bodyMaxBytes) });
  const tooLarge = (req, res) => res.status(413).json({ success: false, code: "MAIL_PAYLOAD_TOO_LARGE", retryable: false, message: "Request body is too large", correlationId: req.correlationId || null });

  return function mailJsonParser(req, res, next) {
    const path = String(req.originalUrl || "").split("?")[0];
    const relative = path.slice(prefix.length) || "/";
    const parser = isRichBodyRoute(req.method, relative) ? rich : small;
    return parser(req, res, (error) => {
      if (error?.type === "entity.too.large") return tooLarge(req, res);
      if (error) return next(error);
      const problem = req.body && typeof req.body === "object" ? jsonShapeProblem(req.body) : null;
      if (problem) return res.status(400).json({ success: false, code: "MAIL_VALIDATION_FAILED", retryable: false, message: "Request body structure is not allowed", errors: [{ field: "body", reason: problem }], correlationId: req.correlationId || null });
      return next();
    });
  };
}

module.exports = { createMailJsonParsing, isRichBodyRoute, jsonShapeProblem, richLimitBytes, SMALL_LIMIT, SHAPE };
