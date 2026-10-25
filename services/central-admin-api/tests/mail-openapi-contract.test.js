"use strict";

// Mail API contract (spec section 9: versioned OpenAPI, typed schemas,
// generated frontend client, contract tests):
//   1. the generated web client matches the current OpenAPI document
//   2. documented success statuses match the router
//   3. every Mail call in the web app targets a documented route + method
//   4. on real PostgreSQL, live responses validate against their schemas and
//      runtime request validation agrees with the documented request bodies

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildOpenApiDocument, PATHS, SUCCESS_STATUS, REQUEST_BODIES } = require("../src/modules/mail/openapi/mail.openapi");
const { generate, OUTPUT } = require("../scripts/mail/generate-web-client");

const ROOT = path.join(__dirname, "..");
const WEB_SRC = path.join(ROOT, "..", "..", "apps", "central-admin-web", "src");
const doc = buildOpenApiDocument();

// ---- minimal JSON-schema validator (the subset the Mail document uses) ----
function resolve(schema) {
  return schema?.$ref ? doc.components.schemas[schema.$ref.split("/").pop()] : schema;
}
function validate(value, schema, at = "$", errors = []) {
  schema = resolve(schema);
  if (!schema || typeof schema !== "object") return errors;
  if (schema.allOf) for (const part of schema.allOf) validate(value, part, at, errors);
  if (schema.oneOf || schema.anyOf) {
    const options = schema.oneOf || schema.anyOf;
    if (!options.some((option) => !validate(value, option, at, []).length)) errors.push(`${at}: matches no alternative`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    const ok = types.some((type) => type === actual || (type === "number" && (actual === "integer" || actual === "number")) || (type === "string" && schema.format === "binary"));
    if (!ok) {
      errors.push(`${at}: expected ${types.join("|")}, got ${actual}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.format === "uuid" && !/^[0-9a-f-]{36}$/i.test(value)) errors.push(`${at}: not a uuid`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${at}: not a date-time`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => validate(item, schema.items, `${at}[${index}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}.${key}: required`);
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) errors.push(`${at}: fewer than ${schema.minProperties} properties`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value && value[key] !== undefined) validate(value[key], child, `${at}.${key}`, errors);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) errors.push(`${at}.${key}: not allowed`);
  }
  return errors;
}

function operation(method, route) {
  return doc.paths[route]?.[method];
}

test("the generated web client is up to date with the OpenAPI document", () => {
  assert.equal(fs.existsSync(OUTPUT), true, "run npm run mail:client:generate");
  assert.equal(fs.readFileSync(OUTPUT, "utf8"), generate(), "stale generated client: run npm run mail:client:generate");
});

test("operation ids are unique and every operation documents its success status", () => {
  const ids = [];
  for (const methods of Object.values(doc.paths)) for (const op of Object.values(methods)) ids.push(op.operationId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, PATHS.length);
  for (const key of Object.keys(REQUEST_BODIES)) {
    const [method, route] = key.split(" ");
    assert.ok(operation(method, route), `request body for an undocumented operation: ${key}`);
  }
});

test("documented success statuses match the router", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "modules", "mail", "http", "mail.routes.js"), "utf8");
  const starts = [...source.matchAll(/^\s*(router|m)\.(get|post|put|patch|delete)\("([^"]+)"/gm)];
  const mismatches = [];
  starts.forEach((match, index) => {
    const chunk = source.slice(match.index, starts[index + 1]?.index ?? source.length);
    const [, owner, method, route] = match;
    const full = (owner === "m" ? `/marketing${route}` : route).replace(/:(\w+)/g, "{$1}");
    if (full === "/openapi.json") return;
    const actual = /status: (20[12])/.exec(chunk)?.[1] || (/res\.status\((\d{3})\)/.exec(chunk)?.[1] === "200" ? "200" : "200");
    const documented = SUCCESS_STATUS[`${method} ${full}`] || "200";
    if (actual !== documented) mismatches.push(`${method} ${full}: router ${actual}, OpenAPI ${documented}`);
  });
  assert.deepEqual(mismatches, []);
});

test("every Mail call in the web app targets a documented route and method", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated" && entry.name !== "node_modules") walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(WEB_SRC);
  const documented = Object.entries(doc.paths).flatMap(([route, methods]) => Object.keys(methods).map((method) => ({ method, segments: `/api/mail/v1${route}`.split("/") })));
  const matchesDoc = (method, url) => {
    const segments = url.split("/");
    return documented.some((entry) => entry.method === method && entry.segments.length === segments.length && entry.segments.every((segment, index) => segment.startsWith("{") || segments[index] === "{}" || segment === segments[index]));
  };
  const problems = [];
  let checked = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const base = /const BASE = "(\/api\/mail\/v1[^"]*)"/.exec(source)?.[1] || null;
    const calls = [
      ...[...source.matchAll(/api\.(get|post|put|patch|delete)(?:<[^(]*>)?\(\s*(`[^`]*`|"[^"]*")/g)].map((m) => ({ method: m[1], literal: m[2] })),
      // Thin wrappers around BASE (mail-marketing.service.ts style).
      ...(base ? [...source.matchAll(/(?<![.\w])(get|list|page|paged|post|patch|put|del)(?:<[^(]*>)?\(\s*(`\/[^`]*`|"\/[^"]*")/g)].map((m) => ({ method: { get: "get", list: "get", page: "get", paged: "get", post: "post", patch: "patch", put: "put", del: "delete" }[m[1]], literal: m[2], wrapped: true })) : []),
    ];
    for (const call of calls) {
      // Generic wrapper bodies (`${BASE}${url}`) are not calls; their callers are scanned.
      if (/^`\$\{BASE\}\$\{\w+\}`$/.test(call.literal)) continue;
      let url = call.literal.slice(1, -1);
      if (call.wrapped) url = `${base}${url}`;
      url = url.replace(/\$\{BASE\}/g, base || "${BASE}").replace(/\$\{MAIL_API_BASE\}/g, "/api/mail/v1");
      if (!url.startsWith("/api/mail/v1")) continue;
      if (/\$\{mailPath\(/.test(call.literal)) continue; // generated paths are type-checked
      url = url.replace(/\$\{[^}]*\}/g, "{}").split("?")[0].replace(/\/$/, "");
      checked += 1;
      if (!matchesDoc(call.method, url)) problems.push(`${path.relative(WEB_SRC, file)}: ${call.method.toUpperCase()} ${url}`);
    }
  }
  assert.ok(checked > 40, `scanned ${checked} handwritten calls`);
  assert.deepEqual(problems, [], "undocumented Mail API calls in the web app");
});

test("live responses and request validation agree with the OpenAPI document (real PostgreSQL)", { timeout: 180000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
  const { closeServer } = require("./helpers/server-close");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: { MAIL_BODY_SEARCH_ENABLED: "true", MAIL_SEARCH_INDEX_KEYS: `s1:${crypto.randomBytes(32).toString("base64")}`, MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS: "partner.example" } });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });

  const conforms = (method, route, response) => {
    const op = operation(method, route);
    assert.ok(op, `${method} ${route} is documented`);
    const status = Object.keys(op.responses).find((code) => code !== "default");
    assert.equal(String(response.status), status, `${method} ${route}: status ${response.status} vs documented ${status}: ${response.text}`);
    const errors = validate(response.body, op.responses[status].content["application/json"].schema);
    assert.deepEqual(errors, [], `${method} ${route} response does not match its schema`);
  };
  const refused = (method, route, response) => {
    assert.ok(response.status >= 400 && response.status < 500, `${method} ${route} accepted a body that violates its schema: ${response.status} ${response.text}`);
  };
  const bodyErrors = (method, route, body) => validate(body, REQUEST_BODIES[`${method} ${route}`]);

  const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
  const mailboxId = box.body.data.id;
  conforms("get", "/me/entitlements", await call("dave", "GET", "/me/entitlements"));
  conforms("get", "/me/mailboxes", await call("dave", "GET", "/me/mailboxes"));

  // Labels
  const labelBody = { name: "Contract" };
  assert.deepEqual(bodyErrors("post", "/mailboxes/{mailboxId}/labels", labelBody), []);
  const label = await call("dave", "POST", `/mailboxes/${mailboxId}/labels`, labelBody);
  assert.equal(label.status, 201);
  refused("post", "/mailboxes/{mailboxId}/labels", await call("dave", "POST", `/mailboxes/${mailboxId}/labels`, { color: "#fff" }));

  // Filters
  const ruleBody = { name: "Contract rule", conditions: { subjectContains: "x" }, actions: { labelId: label.body.data.id, folder: "ARCHIVE" } };
  assert.deepEqual(bodyErrors("post", "/mailboxes/{mailboxId}/rules", ruleBody), []);
  const created = await call("dave", "POST", `/mailboxes/${mailboxId}/rules`, ruleBody);
  conforms("post", "/mailboxes/{mailboxId}/rules", created);
  conforms("get", "/mailboxes/{mailboxId}/rules", await call("dave", "GET", `/mailboxes/${mailboxId}/rules`));
  for (const bad of [{ name: "x", conditions: {}, actions: { star: true } }, { name: "x", conditions: { subjectContains: "x" }, actions: { folder: "INBOX" } }, { name: "x", conditions: { regex: "x" }, actions: { star: true } }]) {
    assert.notDeepEqual(bodyErrors("post", "/mailboxes/{mailboxId}/rules", bad), [], `schema rejects ${JSON.stringify(bad)}`);
    refused("post", "/mailboxes/{mailboxId}/rules", await call("dave", "POST", `/mailboxes/${mailboxId}/rules`, bad));
  }
  conforms("patch", "/rules/{ruleId}", await call("dave", "PATCH", `/rules/${created.body.data.id}`, { enabled: false }));
  refused("patch", "/rules/{ruleId}", await call("dave", "PATCH", `/rules/${created.body.data.id}`, { priority: 0 }));
  conforms("post", "/mailboxes/{mailboxId}/rules/reorder", await call("dave", "POST", `/mailboxes/${mailboxId}/rules/reorder`, { ruleIds: [created.body.data.id] }));
  refused("post", "/mailboxes/{mailboxId}/rules/reorder", await call("dave", "POST", `/mailboxes/${mailboxId}/rules/reorder`, { ruleIds: [] }));

  // Forwarding
  const fwd = await call("dave", "POST", `/mailboxes/${mailboxId}/forwarding`, { targetAddress: "assistant@partner.example", reason: "Contract test" });
  conforms("post", "/mailboxes/{mailboxId}/forwarding", fwd);
  conforms("get", "/mailboxes/{mailboxId}/forwarding", await call("dave", "GET", `/mailboxes/${mailboxId}/forwarding`));
  conforms("get", "/admin/forwarding", await call("ops", "GET", "/admin/forwarding"));
  refused("post", "/mailboxes/{mailboxId}/forwarding", await call("dave", "POST", `/mailboxes/${mailboxId}/forwarding`, { targetAddress: "assistant@partner.example" }));
  conforms("post", "/forwarding/{ruleId}/disable", await call("dave", "POST", `/forwarding/${fwd.body.data.id}/disable`, {}));

  // Drafts, send, threads, messages
  const draftBody = { to: ["partner@partner.example"], subject: "Contract", text: "hello" };
  assert.deepEqual(bodyErrors("post", "/mailboxes/{mailboxId}/drafts", draftBody), []);
  const draft = await call("dave", "POST", `/mailboxes/${mailboxId}/drafts`, draftBody);
  conforms("post", "/mailboxes/{mailboxId}/drafts", draft);
  refused("post", "/drafts/{draftId}/send", await call("dave", "POST", `/drafts/${draft.body.data.id}/send`, {}));
  const sent = await call("dave", "POST", `/drafts/${draft.body.data.id}/send`, { revision: draft.body.data.revision });
  conforms("post", "/drafts/{draftId}/send", sent);
  conforms("get", "/mailboxes/{mailboxId}/threads", await call("dave", "GET", `/mailboxes/${mailboxId}/threads?view=sent`));
  conforms("get", "/threads/{threadId}", await call("dave", "GET", `/threads/${sent.body.data.threadId}`));
  conforms("get", "/threads/{threadId}/messages", await call("dave", "GET", `/threads/${sent.body.data.threadId}/messages`));
  refused("post", "/threads/{threadId}/move", await call("dave", "POST", `/threads/${sent.body.data.threadId}/move`, { folder: "NOWHERE" }));
  refused("post", "/mailboxes/{mailboxId}/threads/bulk", await call("dave", "POST", `/mailboxes/${mailboxId}/threads/bulk`, { threadIds: [sent.body.data.threadId], action: "explode" }));
  conforms("get", "/search", await call("dave", "GET", "/search?q=contract"));
  conforms("get", "/admin/search-index", await call("ops", "GET", "/admin/search-index"));
  refused("post", "/security/step-up", await call("ops", "POST", "/security/step-up", { code: "abc", purpose: "MAIL_JOB_REQUEUE" }));
  refused("post", "/admin/jobs/{jobId}/requeue", await call("ops", "POST", `/admin/jobs/${crypto.randomUUID()}/requeue`, { reason: "x" }));
});
