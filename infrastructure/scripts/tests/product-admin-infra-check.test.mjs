// Unit tests for the Product Admin infrastructure checker. The real resolved
// compose model is checked in CI (`docker compose config --format json`);
// here a model equivalent to it is mutated once per rule to prove each
// check fails closed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCompose, checkPolicy, checkNginx, checkFirewall } from "../product-admin-infra-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "infrastructure/product-admin/staging/network-policy.json"), "utf8"));
const D = "sha256:" + "a".repeat(64);

function hardened(extra) {
  return {
    read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], privileged: false, init: true, pids_limit: 128,
    mem_limit: "402653184", cpus: 0.5, tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=16m"], logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "5" } },
    ...extra,
  };
}

function goodModel() {
  const h = "/srv/cosmicforge/staging", c = "/etc/cosmicforge/staging";
  return {
    name: "cf-product-admin-staging",
    services: {
      "product-integration-core": hardened({
        image: "ghcr.io/cosmicforgehealthnet/product-integration-core@" + D, user: "10002:10002", group_add: ["10001"],
        volumes: [
          { type: "bind", source: h + "/run/pic", target: "/run/cosmicforge/pic" },
          { type: "bind", source: h + "/run/karryam-admin", target: "/run/cosmicforge/karryam", read_only: true },
          { type: "bind", source: c + "/secrets/product-integration-core", target: "/run/secrets/product-integration-core", read_only: true },
        ],
        networks: { "hq-private": null, "admin-private": null },
      }),
      "karryam-admin": hardened({
        image: "ghcr.io/cosmicforgehealthnet/karryam-admin@" + D, user: "10001:10001",
        volumes: [
          { type: "bind", source: h + "/run/karryam-admin", target: "/run/cosmicforge/karryam" },
          { type: "bind", source: c + "/secrets/karryam-admin", target: "/run/secrets/karryam-admin", read_only: true },
        ],
        networks: { "admin-private": null, "karryam-bridge": null, "karryam-admin-db": null },
      }),
      "karryam-admin-worker": hardened({
        image: "ghcr.io/cosmicforgehealthnet/karryam-admin@" + D, user: "10001:10001",
        volumes: [{ type: "bind", source: c + "/secrets/karryam-admin", target: "/run/secrets/karryam-admin", read_only: true }],
        networks: { "karryam-bridge": null, "karryam-admin-db": null },
      }),
      "karryam-admin-db": hardened({
        image: "docker.io/library/postgres@" + D, user: "70:70", mem_limit: "536870912",
        tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=16m", "/var/run/postgresql:rw,noexec,nosuid,nodev,size=1m,uid=70,gid=70,mode=0700"],
        volumes: [
          { type: "volume", source: "karryam-admin-db-data", target: "/var/lib/postgresql/data" },
          { type: "bind", source: c + "/secrets/karryam-admin-db", target: "/run/secrets/karryam-admin-db", read_only: true },
        ],
        networks: { "karryam-admin-db": null },
      }),
    },
    networks: Object.fromEntries(Object.entries(policy.networks).map(([k, n]) => [k, { name: n.name, external: true }])),
  };
}

const failing = (results) => results.filter((r) => !r.ok).map((r) => r.check + (r.service ? ":" + r.service : ""));

test("the reviewed staging model passes every compose check, including digest pinning", () => {
  assert.deepEqual(failing(checkCompose(goodModel(), policy, { requireDigests: true })), []);
});

test("policy, nginx snippet and firewall script pass", () => {
  assert.deepEqual(failing(checkPolicy(policy)), []);
  assert.deepEqual(failing(checkNginx(fs.readFileSync(path.join(ROOT, "infrastructure/product-admin/nginx/internal-deny.conf"), "utf8"), policy)), []);
  assert.deepEqual(failing(checkFirewall(fs.readFileSync(path.join(ROOT, "infrastructure/product-admin/firewall/docker-user-rules.sh"), "utf8"), policy)), []);
});

const MUTATIONS = [
  ["no-published-ports", (m) => { m.services["karryam-admin"].ports = [{ target: 8080, published: "8080" }]; }],
  ["not-privileged", (m) => { m.services["karryam-admin"].privileged = true; }],
  ["no-host-pid", (m) => { m.services["product-integration-core"].pid = "host"; }],
  ["no-expose-to-host", (m) => { m.services["product-integration-core"].network_mode = "host"; }],
  ["read-only-rootfs", (m) => { m.services["karryam-admin-worker"].read_only = false; }],
  ["cap-drop-all", (m) => { m.services["karryam-admin"].cap_drop = ["NET_RAW"]; }],
  ["no-cap-add", (m) => { m.services["karryam-admin-db"].cap_add = ["SYS_ADMIN"]; }],
  ["no-new-privileges", (m) => { m.services["karryam-admin"].security_opt = []; }],
  ["no-unconfined-profiles", (m) => { m.services["karryam-admin"].security_opt.push("seccomp=unconfined"); }],
  ["non-root-numeric-user", (m) => { m.services["karryam-admin"].user = "0:0"; }],
  ["non-root-numeric-user", (m) => { delete m.services["product-integration-core"].user; }],
  ["pids-limit", (m) => { delete m.services["karryam-admin"].pids_limit; }],
  ["memory-limit", (m) => { delete m.services["karryam-admin"].mem_limit; }],
  ["cpu-limit", (m) => { m.services["karryam-admin"].cpus = 0; }],
  ["log-rotation", (m) => { m.services["karryam-admin"].logging = { driver: "json-file" }; }],
  ["tmpfs-bounded", (m) => { m.services["karryam-admin"].tmpfs = ["/tmp"]; }],
  ["no-docker-socket", (m) => { m.services["karryam-admin"].volumes.push({ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }); }],
  ["no-host-root-or-system-mount", (m) => { m.services["karryam-admin"].volumes.push({ type: "bind", source: "/etc", target: "/host-etc", read_only: true }); }],
  ["secrets-read-only", (m) => { m.services["karryam-admin"].volumes[1].read_only = false; }],
  ["image-pinned-by-digest", (m) => { m.services["karryam-admin"].image = "ghcr.io/cosmicforgehealthnet/karryam-admin:staging-latest"; }],
  ["explicit-networks", (m) => { m.services["karryam-admin-worker"].networks = {}; }],
  ["explicit-networks", (m) => { m.services["karryam-admin-worker"].networks.default = null; }],
  ["network-membership-permitted", (m) => { m.services["product-integration-core"].networks["karryam-bridge"] = null; }],
  ["network-membership-permitted", (m) => { m.services["product-integration-core"].networks["karryam-admin-db"] = null; }],
  ["network-membership-required", (m) => { delete m.services["karryam-admin"].networks["karryam-bridge"]; }],
  ["network-external-managed", (m) => { m.networks["karryam-bridge"].external = false; }],
  ["no-unreviewed-network", (m) => { m.networks.extra = { name: "bridge" }; }],
  ["known-service", (m) => { m.services.extra = { ...m.services["karryam-admin"] }; }],
  ["socket-reader-read-only", (m) => { m.services["product-integration-core"].volumes[1].read_only = false; }],
  ["socket-reader-group", (m) => { m.services["product-integration-core"].group_add = []; }],
  ["socket-not-shared", (m) => { m.services["karryam-admin-worker"].volumes.push({ type: "bind", source: "/srv/cosmicforge/staging/run/pic", target: "/run/cosmicforge/pic", read_only: true }); }],
  ["socket-writer-mount", (m) => { m.services["karryam-admin"].volumes[0].read_only = true; }],
  ["project-name", (m) => { m.name = "admin-server-staging"; }],
];

for (const [check, mutate] of MUTATIONS) {
  test(`compose check fails closed: ${check}`, () => {
    const m = goodModel();
    mutate(m);
    const failed = checkCompose(m, policy, { requireDigests: true }).filter((r) => !r.ok).map((r) => r.check);
    assert.ok(failed.includes(check), `expected ${check} to fail, failures: ${failed.join(", ") || "none"}`);
  });
}

test("policy check refuses an HQ component on the Bridge network and contradictory flows", () => {
  const p = structuredClone(policy);
  p.networks["karryam-bridge"].permitted_members.push("product-integration-core");
  p.allowed_flows.push({ from: "central-admin-api", to: "karryam-backoffice-bridge" });
  p.networks["hq-private"].internal = false;
  const failed = failing(checkPolicy(p));
  for (const c of ["policy-bridge-network-excludes-hq", "policy-flow-not-contradictory", "policy-network-internal"]) assert.ok(failed.includes(c), c);
});

test("nginx check refuses a weakened snippet", () => {
  const text = fs.readFileSync(path.join(ROOT, "infrastructure/product-admin/nginx/internal-deny.conf"), "utf8");
  const failed = (t) => failing(checkNginx(t, policy));
  assert.ok(failed(text.replace("location ~* ^/+_?internal", "location ~ ^/internal")).includes("nginx-denies-internal"));
  assert.ok(failed(text.replace('if ($request_uri ~ "^[^?]*%25") { return 400; }', "")).includes("nginx-refuses-double-encoding"));
  assert.ok(failed(text + "\nlocation ^~ /internal/pic/ { proxy_pass http://unix:/run/x.sock; }\n").includes("nginx-no-proxy-to-private"));
});
