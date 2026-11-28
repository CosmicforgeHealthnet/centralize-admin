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
// A network may declare transport modes (cf-staging-cfmeet-bridge:
// PA_CM_BRIDGE_MODE same-host|tunnel). Its top-level fields describe the
// default mode; every mode is checked on its own (internal or a single-
// destination egress allowlist the firewall implements, member set, relay).
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
  // CF Meet's Bridge is reached in one of two transport modes: same-host
  // (default; CF Meet's TCP passthrough relay joins the internal Bridge
  // network at a fixed address, beside CF Meet Admin and its worker only) or
  // tunnel (separate hosts; the one non-internal network, a single-destination
  // egress allowlist, and no Bridge or relay container joins it).
  { id: "cfmeet", optional: true, relay: "cfmeet-admin-bridge-hq-relay", admin: "cfmeet-admin", worker: "cfmeet-admin-worker", db: "cfmeet-admin-db", bridge: "cfmeet-admin-bridge", bridgeNet: "cfmeet-bridge", dbNet: "cfmeet-admin-db" },
]);
export const TRANSPORT_MODES = Object.freeze(["same-host", "tunnel"]);

/** The effective network per transport mode: [[mode, network]]; a network
 * without transport modes has one entry, [null, network]. */
export function networkModes(n) {
  const modes = n && n.transport && n.transport.modes;
  if (!modes || typeof modes !== "object") return [[null, n]];
  return Object.entries(modes).map(([mode, m]) => {
    const { transport, ...base } = n;
    const eff = { ...base, ...m };
    if (m.egress_allowlist === undefined) delete eff.egress_allowlist;
    return [mode, eff];
  });
}
const label = (key, mode) => (mode ? `${key}[${mode}]` : key);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function ip2int(ip) { const m = IPV4.exec(String(ip)); return m && m.slice(1).every((o) => Number(o) <= 255) ? m.slice(1).reduce((a, o) => a * 256 + Number(o), 0) : NaN; }
function inSubnet(ip, cidr) {
  const [net, bits] = String(cidr).split("/"); const size = 2 ** (32 - Number(bits));
  const base = ip2int(net), v = ip2int(ip);
  return Number.isFinite(base) && Number.isFinite(v) && v >= base && v < base + size;
}
/** Problems with a network's fixed addresses: each inside the subnet, not the
 * network/broadcast address, not reserved (Docker gateway), unique, and every
 * fixed member permitted. */
export function fixedAddressProblems(n) {
  const fixed = n.fixed_addresses;
  if (fixed === undefined) return [];
  const problems = [];
  const [net, bits] = String(n.default_subnet).split("/");
  const base = ip2int(net), last = base + 2 ** (32 - Number(bits)) - 1;
  const reserved = new Set(Object.keys(n.reserved_addresses || {}));
  const seen = new Set();
  for (const [member, ip] of Object.entries(fixed)) {
    if (!inSubnet(ip, n.default_subnet)) problems.push(`${member} ${ip} outside ${n.default_subnet}`);
    if (ip2int(ip) === base || ip2int(ip) === last || reserved.has(ip)) problems.push(`${member} ${ip} is a network, broadcast or reserved address`);
    if (seen.has(ip)) problems.push(`${ip} assigned twice`);
    seen.add(ip);
    if (!n.permitted_members.includes(member)) problems.push(`${member} has a fixed address but is not permitted`);
  }
  return problems;
}
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
      // A network with fixed addresses (CF Meet's relay admits only those) has no dynamically addressed member.
      if (n && n.fixed_addresses) {
        const got = ((s.networks || {})[key] || {}).ipv4_address;
        add("network-fixed-address", n.fixed_addresses[name] !== undefined && got === n.fixed_addresses[name], `${name} on ${n.name}: ipv4_address=${got || "unset"}, policy ${n.fixed_addresses[name] || "none"}`, name);
      }
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

const EGRESS_KEYS = new Set(["address_env", "port", "port_env", "protocol", "purpose"]);
const ENV_NAME = /^PA_[A-Z0-9_]+$/;

/** A valid allowlist names exactly ONE destination: an address taken from an
 * operator variable (never a literal, range or wildcard), one TCP port. */
export function egressAllowlistProblems(n) {
  const list = n.egress_allowlist;
  if (!Array.isArray(list) || list.length === 0) return ["no egress_allowlist"];
  if (list.length !== 1) return [`${list.length} destinations (exactly one allowed)`];
  const e = list[0] || {};
  const problems = [];
  for (const k of Object.keys(e)) if (!EGRESS_KEYS.has(k)) problems.push(`unexpected key ${k} (no literal address, range or port list)`);
  if (typeof e.address_env !== "string" || !ENV_NAME.test(e.address_env)) problems.push("address_env must name one PA_* variable");
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) problems.push(`port ${JSON.stringify(e.port)} is not a single TCP port`);
  if (e.port_env !== undefined && (typeof e.port_env !== "string" || !ENV_NAME.test(e.port_env))) problems.push("port_env must name one PA_* variable");
  if (e.protocol !== "tcp") problems.push(`protocol ${JSON.stringify(e.protocol)} (tcp only)`);
  return problems;
}

export function checkPolicy(policy) {
  const out = [];
  const add = (check, ok, detail) => out.push({ check, ok: Boolean(ok), detail });
  const subnets = new Set();
  const productServices = new Set(PRODUCTS.flatMap((p) => [p.admin, p.worker]));
  for (const [key, n] of Object.entries(policy.networks)) {
    if (n.transport !== undefined) {
      // Transport modes: a PA_* switch, a known default, the top level equal to the default mode.
      const t = n.transport || {}, modes = t.modes || {}, def = modes[t.default_mode];
      add("policy-transport-modes", ENV_NAME.test(String(t.mode_env)) && def !== undefined && Object.keys(modes).length > 0 && Object.keys(modes).every((m) => TRANSPORT_MODES.includes(m)), `${key}: ${t.mode_env} in {${Object.keys(modes).join(",")}}, default ${t.default_mode}`);
      add("policy-transport-default-is-top-level", def !== undefined && def.internal === n.internal && JSON.stringify(def.permitted_members) === JSON.stringify(n.permitted_members) && JSON.stringify(def.egress_allowlist) === JSON.stringify(n.egress_allowlist), `${key}: top-level internal/members/allowlist describe the default mode ${t.default_mode}`);
    }
    for (const [mode, v] of networkModes(n)) {
      const k = label(key, mode);
      // Every network (mode) is internal, except one that declares a single-destination
      // egress allowlist (implemented by the firewall; see checkFirewall).
      if (v.internal === true) {
        add("policy-network-internal", true, k);
        add("policy-internal-has-no-allowlist", v.egress_allowlist === undefined, `${k}: an internal network declares no egress allowlist`);
      } else {
        const problems = egressAllowlistProblems(v);
        add("policy-network-internal", v.internal === false && v.egress_allowlist !== undefined, `${k}: internal=${v.internal}; non-internal only with an egress allowlist`);
        add("policy-egress-single-destination", problems.length === 0, `${k}: ${problems.join("; ") || "one destination"}`);
        // Only Product Admin server/worker containers sit behind an egress allowlist: no Bridge, relay, DB or HQ member.
        add("policy-egress-network-members", v.permitted_members.length > 0 && v.permitted_members.every((m) => productServices.has(m)), `${k}: ${v.permitted_members.join(",")}`);
      }
      add("policy-required-subset", v.required_members.every((m) => v.permitted_members.includes(m)), k);
    }
    if (n.fixed_addresses !== undefined) { const fp = fixedAddressProblems(n); add("policy-fixed-addresses", fp.length === 0, `${key}: ${fp.join("; ") || "inside the subnet, unique, permitted, not reserved"}`); }
    add("policy-network-subnet", /^10\.[0-9]{1,3}\.[0-9]{1,3}\.0\/2[4-8]$/.test(n.default_subnet), `${key}=${n.default_subnet}`);
    add("policy-subnet-unique", !subnets.has(n.default_subnet), n.default_subnet);
    subnets.add(n.default_subnet);
  }
  const allowed = new Set(policy.allowed_flows.map((f) => f.from + ">" + f.to));
  for (const f of policy.forbidden_flows) add("policy-flow-not-contradictory", !allowed.has(f.from + ">" + f.to), `${f.from} -> ${f.to}`);
  // Members a network may ever have: the top level and every transport mode.
  const allMembers = (n) => (n ? [...n.permitted_members, ...networkModes(n).flatMap(([, v]) => v.permitted_members)] : []);
  for (const p of PRODUCTS) {
    const musts = [["central-admin-api", p.bridge], ["product-integration-core", p.bridge], ["central-admin-api", p.db], [p.admin, "hq-database"]];
    if (p.relay) musts.push(["central-admin-api", p.relay], ["product-integration-core", p.relay], [p.relay, p.db], [p.relay, "hq-database"]);
    for (const must of musts) {
      add("policy-forbids-required-bypass", policy.forbidden_flows.some((f) => f.from === must[0] && f.to === must[1]), must.join(" -> "));
    }
    // No HQ component may share a network with the Bridge (in any transport mode).
    const bridge = policy.networks[p.bridgeNet];
    add("policy-bridge-network-excludes-hq", bridge && !allMembers(bridge).some((m) => ["central-admin-api", "product-integration-core", "hq-database"].includes(m)), `${p.bridgeNet} members`);
    if (p.relay) {
      const modes = Object.fromEntries(bridge ? networkModes(bridge) : []);
      const same = modes["same-host"], tunnel = modes.tunnel;
      // same-host: internal, exactly {admin, worker, relay}, the relay at its fixed address; the Bridge itself never joins.
      add("policy-same-host-relay", same && same.internal === true && same.egress_allowlist === undefined
        && JSON.stringify([...same.permitted_members].sort()) === JSON.stringify([p.admin, p.worker, p.relay].sort())
        && bridge.fixed_addresses && [p.admin, p.worker, p.relay].every((m) => bridge.fixed_addresses[m] !== undefined),
        `${p.bridgeNet}[same-host]: internal, members exactly ${p.admin}, ${p.worker}, ${p.relay}, each with a fixed address`);
      // tunnel: the egress-allowlisted network; neither the Bridge nor the relay is a member.
      add("policy-remote-bridge-not-member", tunnel && tunnel.internal === false && !tunnel.permitted_members.includes(p.bridge) && !tunnel.permitted_members.includes(p.relay), `${p.bridgeNet}[tunnel]: ${p.bridge} is remote (tunnel), never a member; network is the egress-allowlisted one`);
      add("policy-remote-bridge-not-member", !allMembers(bridge).includes(p.bridge), `${p.bridgeNet}: ${p.bridge} never joins (same-host: only its relay ${p.relay})`);
      // The relay is a member of no other network.
      const elsewhere = Object.entries(policy.networks).filter(([k, n]) => k !== p.bridgeNet && allMembers(n).includes(p.relay)).map(([k]) => k);
      add("policy-relay-only-on-bridge-network", elsewhere.length === 0, `${p.relay} only on ${p.bridgeNet}${elsewhere.length ? "; also on " + elsewhere.join(",") : ""}`);
    }
    const db = policy.networks[p.dbNet];
    add("policy-db-b-excludes-hq", db && !db.permitted_members.some((m) => ["central-admin-api", "product-integration-core"].includes(m)), `${p.dbNet} members`);
    // Product Admins are isolated from each other: no other product's service
    // (or relay) on this product's Bridge or database network, no socket shared between them.
    const others = PRODUCTS.filter((o) => o !== p).flatMap((o) => [o.admin, o.worker, o.db, o.bridge, ...(o.relay ? [o.relay] : [])]);
    add("policy-product-networks-isolated", [bridge, db].every((n) => n && !allMembers(n).some((m) => others.includes(m))), `${p.bridgeNet}, ${p.dbNet} exclude other products`);
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
  add("firewall-protects-db-and-bridge-ports", /\bPORTS=\([^)]*\b5432\b[^)]*\b8110\b[^)]*\b8460\b[^)]*\)/.test(text), "PORTS covers 5432, 8110 and 8460 (the CF Meet Bridge port must not be published on the HQ host either)");
  // Each non-internal network (or transport mode): the firewall implements its single allowed destination and drops everything else.
  const esc = (v) => v.replace(/[$]/g, "\\$");
  const lf = text.replace(/\r/g, "");
  for (const [key, n0] of Object.entries(policy.networks)) {
    if (n0.transport) {
      // The mode switch: same default, unknown modes refused, and the allowlist plus the subnet
      // drops emitted only in the non-internal mode (an internal mode keeps traffic inside its
      // own subnet, e.g. CF Meet Admin to the same-host relay, untouched).
      const t = n0.transport, modes = Object.keys(t.modes || {});
      add("firewall-implements-transport-modes", text.includes(`${t.mode_env}="\${${t.mode_env}:-${t.default_mode}}"`), `${key}: ${t.mode_env} defaults to ${t.default_mode}`);
      add("firewall-implements-transport-modes", text.includes(`${modes.join("|")}) ;;`) || text.includes(`${[...modes].reverse().join("|")}) ;;`), `${key}: only ${modes.join(", ")} accepted`);
      for (const [mode, v] of networkModes(n0)) {
        if (v.internal === true || !(v.egress_allowlist || [])[0]) continue;
        const addr = esc("$" + v.egress_allowlist[0].address_env), head = `if \\[\\[ "\\$${t.mode_env}" == ${mode} \\]\\]; then\\n`;
        add("firewall-implements-transport-modes", new RegExp(`${head}\\s*if \\[\\[ -n "${addr}" \\]\\]`).test(lf), `${key}: the egress allowlist is emitted only in ${mode} mode`);
        // The block of that branch (up to the `fi` at the same indentation) holds every subnet drop line.
        const m = new RegExp(`^( *)${head}`, "m").exec(lf);
        const blockEnd = m ? lf.indexOf(`\n${m[1]}fi\n`, m.index) : -1;
        const block = blockEnd > 0 ? lf.slice(m.index, blockEnd) : "";
        const subVar = "$" + n0.subnet_env;
        const drops = ["-s", "-d"].map((dir) => `echo "DOCKER-USER ${dir} ${subVar} -m comment --comment $TAG -j DROP"`);
        add("firewall-implements-transport-modes", block !== "" && drops.every((d) => block.includes(d) && lf.split(d).length === block.split(d).length), `${key}: the subnet drops are emitted only in ${mode} mode`);
      }
    }
    for (const [mode, n] of networkModes(n0)) {
      if (n.internal === true) continue;
      const k = label(key, mode);
      const e = (n.egress_allowlist || [])[0];
      if (!e || egressAllowlistProblems(n).length) { add("firewall-implements-egress-allowlist", false, `${k}: no valid allowlist to implement`); continue; }
      const sub = esc("$" + n.subnet_env), addr = esc("$" + e.address_env), port = e.port_env ? esc("$" + e.port_env) : String(e.port);
      const rules = {
        allow: new RegExp(`DOCKER-USER -s ${sub} -d ${addr}/32 -p tcp --dport ${port} -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment \\$TAG -j RETURN`),
        replies: new RegExp(`DOCKER-USER -s ${addr}/32 -d ${sub} -p tcp --sport ${port} -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment \\$TAG -j RETURN`),
        "no-other-source-or-port": new RegExp(`DOCKER-USER -d ${addr}/32 -m conntrack --ctstate NEW -m comment --comment \\$TAG -j DROP`),
        "drop-other-egress": new RegExp(`DOCKER-USER -s ${sub} -m comment --comment \\$TAG -j DROP`),
        "drop-other-ingress": new RegExp(`DOCKER-USER -d ${sub} -m comment --comment \\$TAG -j DROP`),
        "drop-to-host": new RegExp(`INPUT -s ${sub} -m comment --comment \\$TAG -j DROP`),
      };
      for (const [name, re] of Object.entries(rules)) add("firewall-implements-egress-allowlist", re.test(text), `${k}: ${name}`);
      if (e.port_env) add("firewall-implements-egress-allowlist", text.includes(`${e.port_env}="\${${e.port_env}:-${e.port}}"`), `${k}: ${e.port_env} defaults to ${e.port}`);
      add("firewall-validates-egress-address", /RFC 1918/.test(text) && /in_cidr "\$PA_CM_BRIDGE_ADDRESS" "\$s"/.test(text) && text.includes(e.address_env), `${k}: ${e.address_env} validated (RFC 1918, outside every Product Admin subnet)`);
      add("firewall-verifies-exact-set", /UNEXPECTED/.test(text) && /iptables -C "\$chain"/.test(text), `${k}: verify checks every rule and no extra tagged rule`);
    }
  }
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
