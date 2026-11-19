#!/usr/bin/env node
// Product Admin infrastructure security check (Sections 12.1, 12.2, 13.1.8).
//
// Static, dependency-free. Validates the RESOLVED staging compose model
// (`docker compose config --format json`, so anchors/overrides are already
// applied) against infrastructure/product-admin/staging/network-policy.json,
// plus the Nginx deny snippet and the firewall rules script.
//
//   node infrastructure/scripts/product-admin-infra-check.mjs \
//     --compose-json resolved.json [--require-digests] [--require-product cfmeet] [--report out.json]
//
// CF Meet Admin is optional (compose profile "cfmeet"): a model without any
// CF Meet service is valid; a model with one must have all three, and
// --require-product cfmeet makes them mandatory (deploy passes it when the
// release includes CF Meet Admin).
//
// Without --compose-json only the policy, Nginx and firewall checks run (and
// the report says the compose model was NOT checked). Exit 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY_FILE = path.join(ROOT, "infrastructure/product-admin/staging/network-policy.json");
const NGINX_FILE = path.join(ROOT, "infrastructure/product-admin/nginx/internal-deny.conf");
const FIREWALL_FILE = path.join(ROOT, "infrastructure/product-admin/firewall/docker-user-rules.sh");

const DIGEST_REF = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
// Product Admins on the shared staging host. Each has its own Bridge network,
// database network, socket and uid; none may reach another's.
export const PRODUCTS = Object.freeze([
  { id: "karryam", admin: "karryam-admin", worker: "karryam-admin-worker", db: "karryam-admin-db", bridge: "karryam-backoffice-bridge", bridgeNet: "karryam-bridge", dbNet: "karryam-admin-db" },
  { id: "cfmeet", optional: true, admin: "cfmeet-admin", worker: "cfmeet-admin-worker", db: "cfmeet-admin-db", bridge: "cfmeet-admin-bridge", bridgeNet: "cfmeet-bridge", dbNet: "cfmeet-admin-db" },
]);
const PRIVATE_SERVICES = new Set(["product-integration-core", ...PRODUCTS.flatMap((p) => [p.admin, p.worker, p.db])]);
const MAX_MEM_BYTES = 1024 * 1024 * 1024;

function toBytes(v) {
  if (typeof v === "number") return v;
  const m = /^([0-9.]+)\s*([kmg]?)b?$/i.exec(String(v || ""));
  if (!m) return NaN;
  return Number(m[1]) * { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
}

function list(v) { return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]; }

/** Checks one resolved compose model. Returns an array of { check, service?, ok, detail }. */
export function checkCompose(model, policy, { requireDigests = false, requireProducts = [] } = {}) {
  const out = [];
  const add = (check, ok, detail, service) => out.push({ check, service, ok: Boolean(ok), detail });
  const services = model.services || {};
  const netByKey = policy.networks;
  const nameToKey = Object.fromEntries(Object.entries(netByKey).map(([k, n]) => [n.name, k]));
  // An optional product counts as deployed when any of its services is in the
  // model (or it is explicitly required); then all of its services must be.
  const deployed = new Set(PRODUCTS.filter((p) => !p.optional || requireProducts.includes(p.id) || [p.admin, p.worker, p.db].some((n) => services[n])).map((p) => p.id));
  const absentNetworks = new Set(PRODUCTS.filter((p) => !deployed.has(p.id)).flatMap((p) => [p.bridgeNet, p.dbNet]));
  for (const id of requireProducts) add("required-product-known", PRODUCTS.some((p) => p.id === id), id);

  add("project-name", model.name === policy.compose_project, `project=${model.name}`);
  add("service-present", services["product-integration-core"], "product-integration-core", "product-integration-core");
  for (const p of PRODUCTS.filter((x) => deployed.has(x.id))) for (const expected of [p.admin, p.worker, p.db]) add("service-present", services[expected], expected, expected);

  for (const [name, s] of Object.entries(services)) {
    add("known-service", PRIVATE_SERVICES.has(name), "only the reviewed private services may be in this project", name);
    add("no-published-ports", list(s.ports).length === 0, `ports=${JSON.stringify(s.ports || [])}`, name);
    add("no-expose-to-host", !s.network_mode, `network_mode=${s.network_mode || "unset"}`, name);
    add("not-privileged", s.privileged !== true, "privileged must be false", name);
    add("no-host-pid", s.pid !== "host", "pid", name);
    add("no-host-ipc", s.ipc !== "host", "ipc", name);
    add("no-host-uts", s.uts !== "host", "uts", name);
    add("no-devices", list(s.devices).length === 0, "devices", name);
    add("read-only-rootfs", s.read_only === true, "read_only", name);
    add("cap-drop-all", list(s.cap_drop).map(String).map((c) => c.toUpperCase()).includes("ALL"), "cap_drop", name);
    add("no-cap-add", list(s.cap_add).length === 0, `cap_add=${JSON.stringify(s.cap_add || [])}`, name);
    add("no-new-privileges", list(s.security_opt).some((o) => /^no-new-privileges(:true)?$/.test(String(o))), "security_opt", name);
    add("no-unconfined-profiles", !list(s.security_opt).some((o) => /unconfined/.test(String(o))), "seccomp/apparmor must not be unconfined", name);
    const user = String(s.user || "");
    const uid = /^([0-9]+)(?::([0-9]+))?$/.exec(user);
    add("non-root-numeric-user", uid && Number(uid[1]) > 0 && (uid[2] === undefined || Number(uid[2]) > 0), `user=${user || "unset"}`, name);
    add("pids-limit", Number(s.pids_limit) > 0 && Number(s.pids_limit) <= 512, `pids_limit=${s.pids_limit}`, name);
    const mem = toBytes(s.mem_limit);
    add("memory-limit", mem > 0 && mem <= MAX_MEM_BYTES, `mem_limit=${s.mem_limit}`, name);
    add("cpu-limit", Number(s.cpus) > 0 && Number(s.cpus) <= 2, `cpus=${s.cpus}`, name);
    const log = s.logging || {};
    add("log-rotation", log.driver === "json-file" && log.options && toBytes(log.options["max-size"]) > 0 && Number(log.options["max-file"]) > 0, `logging=${JSON.stringify(log)}`, name);
    const tmpfs = list(s.tmpfs).map(String);
    add("tmpfs-bounded", tmpfs.length > 0 && tmpfs.every((t) => /size=/.test(t) && /nosuid/.test(t)), `tmpfs=${JSON.stringify(tmpfs)}`, name);

    const volumes = list(s.volumes);
    for (const v of volumes) {
      const source = String(v.source || "");
      const target = String(v.target || "");
      add("no-docker-socket", !/docker\.sock/.test(source) && !/docker\.sock/.test(target), `${source}->${target}`, name);
      add("no-host-root-or-system-mount", !["/", "/etc", "/var", "/root", "/home", "/proc", "/sys", "/dev", "/run", "/var/run"].includes(source.replace(/\/+$/, "") || "/") || v.type === "volume", `${source}`, name);
      if (/\/secrets(\/|$)/.test(target)) add("secrets-read-only", v.read_only === true, `${target}`, name);
    }
    if (requireDigests) add("image-pinned-by-digest", DIGEST_REF.test(String(s.image || "")), `image=${s.image}`, name);

    // Network membership must match the policy exactly.
    const nets = Object.keys(s.networks || {});
    add("explicit-networks", nets.length > 0 && !nets.includes("default"), `networks=${nets.join(",") || "none (would join the default network)"}`, name);
    for (const key of nets) {
      const policyKey = netByKey[key] ? key : nameToKey[key];
      const n = policyKey && netByKey[policyKey];
      add("network-in-policy", n, `network ${key}`, name);
      if (n) add("network-membership-permitted", n.permitted_members.includes(name), `${name} on ${n.name}`, name);
    }
    for (const [key, n] of Object.entries(netByKey)) {
      if (n.required_members.includes(name)) add("network-membership-required", nets.includes(key), `${name} must be on ${n.name}`, name);
    }
  }

  const models = model.networks || {};
  for (const [key, n] of Object.entries(netByKey)) {
    const m = models[key];
    // Networks used only by an optional product that is not deployed may be pruned from the model.
    if (!m && absentNetworks.has(key)) continue;
    add("network-declared", m, key);
    if (!m) continue;
    add("network-name", m.name === n.name, `${key}=${m.name}`);
    add("network-external-managed", m.external === true, `${key} is created and audited by prepare-host`);
  }
  for (const key of Object.keys(models)) add("no-unreviewed-network", netByKey[key], `network ${key}`);

  // Socket ownership model: the writer has the socket dir mounted rw, the
  // readers read-only; nothing else mounts it.
  for (const [sock, spec] of Object.entries(policy.sockets)) {
    for (const [name, s] of Object.entries(services)) {
      const m = list(s.volumes).find((v) => String(v.source || "").replace(/\\/g, "/").endsWith("/" + spec.host_dir));
      if (name === spec.writer) {
        add("socket-writer-mount", m && m.read_only !== true && m.target === spec.container_dir, `${sock} writable at ${spec.container_dir}`, name);
        add("socket-writer-uid", String(s.user || "").startsWith(String(spec.owner_uid) + ":"), `${sock} owned by ${spec.owner_uid}`, name);
      } else if (spec.readers.includes(name)) {
        add("socket-reader-read-only", m && m.read_only === true, `${sock} read-only`, name);
        add("socket-reader-group", list(s.group_add).map(String).includes(String(spec.owner_gid)), `${name} in group ${spec.owner_gid}`, name);
      } else {
        add("socket-not-shared", !m, `${sock} must not be mounted into ${name}`, name);
      }
    }
  }
  return out;
}

export function checkPolicy(policy) {
  const out = [];
  const add = (check, ok, detail) => out.push({ check, ok: Boolean(ok), detail });
  const subnets = new Set();
  for (const [key, n] of Object.entries(policy.networks)) {
    add("policy-network-internal", n.internal === true, key);
    add("policy-network-subnet", /^10\.[0-9]{1,3}\.[0-9]{1,3}\.0\/2[4-8]$/.test(n.default_subnet), `${key}=${n.default_subnet}`);
    add("policy-subnet-unique", !subnets.has(n.default_subnet), n.default_subnet);
    subnets.add(n.default_subnet);
    add("policy-required-subset", n.required_members.every((m) => n.permitted_members.includes(m)), key);
  }
  const allowed = new Set(policy.allowed_flows.map((f) => f.from + ">" + f.to));
  for (const f of policy.forbidden_flows) add("policy-flow-not-contradictory", !allowed.has(f.from + ">" + f.to), `${f.from} -> ${f.to}`);
  for (const p of PRODUCTS) {
    for (const must of [["central-admin-api", p.bridge], ["product-integration-core", p.bridge], ["central-admin-api", p.db], [p.admin, "hq-database"]]) {
      add("policy-forbids-required-bypass", policy.forbidden_flows.some((f) => f.from === must[0] && f.to === must[1]), must.join(" -> "));
    }
    // No HQ component may share a network with the Bridge.
    const bridge = policy.networks[p.bridgeNet];
    add("policy-bridge-network-excludes-hq", bridge && !bridge.permitted_members.some((m) => ["central-admin-api", "product-integration-core", "hq-database"].includes(m)), `${p.bridgeNet} members`);
    const db = policy.networks[p.dbNet];
    add("policy-db-b-excludes-hq", db && !db.permitted_members.some((m) => ["central-admin-api", "product-integration-core"].includes(m)), `${p.dbNet} members`);
    // Product Admins are isolated from each other: no other product's service
    // on this product's Bridge or database network, no socket shared between them.
    const others = PRODUCTS.filter((o) => o !== p).flatMap((o) => [o.admin, o.worker, o.db, o.bridge]);
    add("policy-product-networks-isolated", [bridge, db].every((n) => n && !n.permitted_members.some((m) => others.includes(m))), `${p.bridgeNet}, ${p.dbNet} exclude other products`);
    const sock = Object.values(policy.sockets || {}).find((s) => s.writer === p.admin);
    add("policy-product-socket", sock && sock.readers.length === 1 && sock.readers[0] === "product-integration-core", `${p.admin} socket read only by product-integration-core`);
    for (const o of PRODUCTS.filter((x) => x !== p)) {
      for (const to of [o.bridge, o.db]) add("policy-forbids-cross-product", policy.forbidden_flows.some((f) => f.from === p.admin && f.to === to), `${p.admin} -> ${to}`);
    }
  }
  const uids = Object.values(policy.sockets || {}).map((s) => s.owner_uid);
  add("policy-socket-uids-unique", new Set(uids).size === uids.length, `socket owner uids ${uids.join(",")}`);
  return out;
}

export function checkNginx(text, policy) {
  const out = [];
  const add = (check, ok, detail) => out.push({ check, ok: Boolean(ok), detail });
  const body = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  add("nginx-denies-internal", /location ~\* \^\/\+_\?internal\(\?:\[\^a-z0-9_-\]\|\$\) \{ return 404; \}/.test(body), "regex location for /internal and /_internal, case-insensitive");
  add("nginx-denies-private-endpoints", /location ~\* \^\/\+\(\?:metrics\|sync\/status\|health\/live\|health\/ready\)/.test(body), "metrics, sync/status, health/live, health/ready");
  add("nginx-refuses-double-encoding", /if \(\$request_uri ~ "\^\[\^\?\]\*%25"\) \{ return 400; \}/.test(body), "%25 in path");
  add("nginx-no-proxy-to-private", !/proxy_pass|fastcgi_pass|uwsgi_pass|grpc_pass/.test(body), "the snippet never routes anywhere");
  add("nginx-no-prefix-override", !/location\s+(\^~|=)\s*\/(_?internal|metrics|sync|health)/.test(body), "no ^~ or = location that would bypass the regex");
  for (const prefix of policy.public_ingress.denied_path_prefixes) {
    const bare = prefix.replace(/^\//, "");
    add("nginx-covers-policy-prefix", body.includes(bare.replace(/^_/, "")) || body.includes(bare), prefix);
  }
  return out;
}

export function checkFirewall(text, policy) {
  const out = [];
  const add = (check, ok, detail) => out.push({ check, ok: Boolean(ok), detail });
  add("firewall-uses-docker-user", /DOCKER-USER/.test(text), "rules live in DOCKER-USER (UFW alone does not filter published Docker ports)");
  add("firewall-has-verify", /verify\)/.test(text), "verify mode");
  for (const [key, n] of Object.entries(policy.networks)) add("firewall-covers-subnet", text.includes(n.subnet_env), `${key} via ${n.subnet_env}`);
  add("firewall-protects-db-and-bridge-ports", /5432/.test(text) && /8110/.test(text), "5432 and 8110");
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
  const results = [
    ...checkPolicy(policy).map((r) => ({ area: "policy", ...r })),
    ...checkNginx(fs.readFileSync(NGINX_FILE, "utf8"), policy).map((r) => ({ area: "nginx", ...r })),
    ...checkFirewall(fs.readFileSync(FIREWALL_FILE, "utf8"), policy).map((r) => ({ area: "firewall", ...r })),
  ];
  let composeChecked = false;
  if (args["compose-json"]) {
    const model = JSON.parse(fs.readFileSync(args["compose-json"], "utf8"));
    const requireProducts = args["require-product"] && args["require-product"] !== "true" ? args["require-product"].split(",") : [];
    results.push(...checkCompose(model, policy, { requireDigests: args["require-digests"] === "true", requireProducts }).map((r) => ({ area: "compose", ...r })));
    composeChecked = true;
  }
  const failed = results.filter((r) => !r.ok);
  const report = {
    report: "product-admin-network-policy-report",
    source_sha: process.env.GITHUB_SHA || null,
    generated_at: new Date().toISOString(),
    environment: policy.environment,
    policy_version: policy.version,
    compose_model_checked: composeChecked,
    digests_required: args["require-digests"] === "true",
    total: results.length,
    failed: failed.length,
    result: failed.length ? "FAIL" : composeChecked ? "PASS" : "PARTIAL_NO_COMPOSE_MODEL",
    checks: results,
  };
  if (args.report) { fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true }); fs.writeFileSync(args.report, JSON.stringify(report, null, 2)); }
  for (const f of failed) process.stdout.write(`FAIL [${f.area}] ${f.check}${f.service ? " (" + f.service + ")" : ""}: ${f.detail}\n`);
  process.stdout.write(`product-admin infra check: ${results.length - failed.length}/${results.length} passed${composeChecked ? "" : " (compose model not checked)"}\n`);
  process.exit(failed.length ? 1 : 0);
}
