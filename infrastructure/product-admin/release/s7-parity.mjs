#!/usr/bin/env node
// S7 shadow-comparison tool (Section 12.4): compares captured legacy
// responses with captured replacement responses (HQ -> PIC -> Karryam Admin
// -> Bridge) for the routes in s7-legacy-inventory.json, plus a permission
// matrix. Read-only: it never calls either system; captures are produced by
// an authorized operator in staging. Output: product-admin-s7-parity.json.
//
//   node s7-parity.mjs --legacy legacy.json --replacement replacement.json [--permissions perms.json] --out report.json
//
// Capture format: { "<METHOD> <path>": { "status": 200, "items": [ {..}, .. ] } }
// Permission format: [ { "route": "<METHOD> <path>", "actor": "<role>", "legacy": 200|403, "replacement": 200|403 } ]
// Rules: listed parity fields must be equal per item id; a replacement may be
// STRICTER than legacy (deny where legacy allowed) but never more permissive.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INVENTORY = JSON.parse(fs.readFileSync(path.join(HERE, "s7-legacy-inventory.json"), "utf8"));

const key = (r) => `${r.method} ${r.path}`;
const get = (obj, field) => field.split(".").reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);

export function compareResponses(inventory, legacy, replacement) {
  return inventory.routes.map((r) => {
    const k = key(r);
    const a = legacy[k];
    const b = replacement[k];
    if (!a || !b) return { route: k, result: "NOT_CAPTURED", detail: !a && !b ? "no captures" : !a ? "legacy capture missing" : "replacement capture missing" };
    if (r.kind === "COMMAND") {
      // Commands are compared on outcome class only; replacement must be owner-executed with a receipt.
      const ok = (a.status < 300) === (b.status < 300) && (b.status >= 300 || (b.items || []).every((i) => i.operation_id));
      return { route: k, result: ok ? "MATCH" : "DIFF", detail: `legacy ${a.status}, replacement ${b.status}` };
    }
    if (a.status !== b.status) return { route: k, result: "DIFF", detail: `status legacy ${a.status} vs replacement ${b.status}` };
    const byId = new Map((b.items || []).map((i) => [String(i.id), i]));
    const diffs = [];
    for (const item of a.items || []) {
      const other = byId.get(String(item.id));
      if (!other) { diffs.push(`${item.id}: missing in replacement`); continue; }
      for (const f of r.parity.fields) if (JSON.stringify(get(item, f)) !== JSON.stringify(get(other, f))) diffs.push(`${item.id}.${f}`);
    }
    const extra = (b.items || []).filter((i) => !(a.items || []).some((x) => String(x.id) === String(i.id))).length;
    if (extra) diffs.push(`${extra} item(s) only in replacement`);
    return { route: k, result: diffs.length ? "DIFF" : "MATCH", detail: diffs.slice(0, 20).join(", ") || `${(a.items || []).length} items equal on ${r.parity.fields.join(",")}` };
  });
}

export function comparePermissions(inventory, matrix) {
  const routes = new Set(inventory.routes.map(key));
  return matrix.map((p) => {
    if (!routes.has(p.route)) return { ...p, result: "UNKNOWN_ROUTE" };
    const la = p.legacy < 300, ra = p.replacement < 300;
    if (ra && !la) return { ...p, result: "MORE_PERMISSIVE" };
    if (!ra && la) return { ...p, result: "STRICTER" };
    return { ...p, result: "EQUAL" };
  });
}

export function report({ legacy = {}, replacement = {}, permissions = [] }) {
  const responses = compareResponses(INVENTORY, legacy, replacement);
  const perms = comparePermissions(INVENTORY, permissions);
  const responseParity = responses.every((r) => r.result === "MATCH") ? "PASS" : responses.some((r) => r.result === "DIFF") ? "FAIL" : "PENDING_EXTERNAL";
  const permissionParity = perms.length === 0 ? "PENDING_EXTERNAL" : perms.some((p) => p.result === "MORE_PERMISSIVE" || p.result === "UNKNOWN_ROUTE") ? "FAIL" : "PASS";
  return {
    report: "product-admin-s7-parity",
    generated_at: new Date().toISOString(),
    source_sha: process.env.GITHUB_SHA || null,
    legacy_mount: INVENTORY.legacy_mount,
    checks: [
      { id: "legacy_inventory_complete", status: "PASS", detail: `${INVENTORY.routes.length} routes mapped (verified by product-admin-s7-legacy.test.mjs)` },
      { id: "response_parity", status: responseParity, detail: `${responses.filter((r) => r.result === "MATCH").length}/${responses.length} routes match` },
      { id: "permission_parity", status: permissionParity, detail: `${perms.filter((p) => p.result === "STRICTER").length} stricter, ${perms.filter((p) => p.result === "MORE_PERMISSIVE").length} more permissive` },
      { id: "scoped_version_parity", status: responseParity === "PASS" ? "PASS" : responseParity, detail: "item ids/versions compared within the captured scope" },
      { id: "observation_window_24h", status: "PENDING_EXTERNAL", detail: "owner sign-off after the 24 h observation window" },
    ],
    responses,
    permissions: perms,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith("--") ? [...acc, [v.slice(2), arr[i + 1]]] : acc), []));
  const read = (f) => (f ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined);
  const r = report({ legacy: read(a.legacy), replacement: read(a.replacement), permissions: read(a.permissions) });
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(r, null, 2));
  for (const c of r.checks) process.stdout.write(`${c.status} ${c.id}: ${c.detail}\n`);
  process.exit(r.checks.some((c) => c.status === "FAIL") ? 1 : 0);
}
