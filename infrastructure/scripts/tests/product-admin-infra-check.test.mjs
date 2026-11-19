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
        image: "ghcr.io/cosmicforgehealthnet/product-integration-core@" + D, user: "10002:10002", group_add: ["10001", "10003"],
        volumes: [
          { type: "bind", source: h + "/run/pic", target: "/run/cosmicforge/pic" },
          { type: "bind", source: h + "/run/karryam-admin", target: "/run/cosmicforge/karryam", read_only: true },
          { type: "bind", source: h + "/run/cfmeet-admin", target: "/run/cosmicforge/cfmeet", read_only: true },
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
      "cfmeet-admin": hardened({
        image: "ghcr.io/cosmicforgehealthnet/cfmeet-admin@" + D, user: "10003:10003",
        volumes: [
          { type: "bind", source: h + "/run/cfmeet-admin", target: "/run/cosmicforge/cfmeet" },
          { type: "bind", source: c + "/secrets/cfmeet-admin", target: "/run/secrets/cfmeet-admin", read_only: true },
        ],
        networks: { "cfmeet-bridge": null, "cfmeet-admin-db": null },
      }),
      "cfmeet-admin-worker": hardened({
        image: "ghcr.io/cosmicforgehealthnet/cfmeet-admin@" + D, user: "10003:10003",
        volumes: [{ type: "bind", source: c + "/secrets/cfmeet-admin", target: "/run/secrets/cfmeet-admin", read_only: true }],
        networks: { "cfmeet-bridge": null, "cfmeet-admin-db": null },
      }),
      "cfmeet-admin-db": hardened({
        image: "docker.io/library/postgres@" + D, user: "70:70", mem_limit: "536870912",
        tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=16m", "/var/run/postgresql:rw,noexec,nosuid,nodev,size=1m,uid=70,gid=70,mode=0700"],
        volumes: [
          { type: "volume", source: "cfmeet-admin-db-data", target: "/var/lib/postgresql/data" },
          { type: "bind", source: c + "/secrets/cfmeet-admin-db", target: "/run/secrets/cfmeet-admin-db", read_only: true },
        ],
        networks: { "cfmeet-admin-db": null },
      }),
    },
    networks: Object.fromEntries(Object.entries(policy.networks).map(([k, n]) => [k, { name: n.name, external: true }])),
  };
}

const failing = (results) => results.filter((r) => !r.ok).map((r) => r.check + (r.service ? ":" + r.service : ""));

test("the reviewed staging model passes every compose check, including digest pinning", () => {
  assert.deepEqual(failing(checkCompose(goodModel(), policy, { requireDigests: true })), []);
});

test("CF Meet Admin is optional: a Karryam + PIC model passes; a partial or required-but-missing CF Meet model fails", () => {
  const m = goodModel();
  for (const n of ["cfmeet-admin", "cfmeet-admin-worker", "cfmeet-admin-db"]) delete m.services[n];
  delete m.networks["cfmeet-bridge"]; delete m.networks["cfmeet-admin-db"];
  // PIC keeps the read-only CF Meet socket mount and group 10003 even without CF Meet Admin.
  assert.deepEqual(failing(checkCompose(m, policy, { requireDigests: true })), []);
  const required = failing(checkCompose(m, policy, { requireDigests: true, requireProducts: ["cfmeet"] }));
  for (const f of ["service-present:cfmeet-admin", "service-present:cfmeet-admin-db", "network-declared"]) assert.ok(required.includes(f), f);
  const partial = goodModel();
  delete partial.services["cfmeet-admin-db"];
  assert.ok(failing(checkCompose(partial, policy)).includes("service-present:cfmeet-admin-db"));
  // Karryam is never optional.
  const noKarryam = goodModel();
  delete noKarryam.services["karryam-admin"];
  assert.ok(failing(checkCompose(noKarryam, policy)).includes("service-present:karryam-admin"));
  assert.ok(failing(checkCompose(goodModel(), policy, { requireProducts: ["unknown"] })).includes("required-product-known"));
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
  // CF Meet Admin: same rules, and no path into a Karryam network, socket or database.
  ["service-present", (m) => { delete m.services["cfmeet-admin-db"]; }],
  ["network-declared", (m) => { delete m.networks["cfmeet-bridge"]; }],
  ["non-root-numeric-user", (m) => { m.services["cfmeet-admin"].user = "0:0"; }],
  ["secrets-read-only", (m) => { m.services["cfmeet-admin-worker"].volumes[0].read_only = false; }],
  ["image-pinned-by-digest", (m) => { m.services["cfmeet-admin"].image = "ghcr.io/cosmicforgehealthnet/cfmeet-admin:staging-latest"; }],
  ["network-membership-permitted", (m) => { m.services["cfmeet-admin"].networks["karryam-bridge"] = null; }],
  ["network-membership-permitted", (m) => { m.services["cfmeet-admin-worker"].networks["karryam-admin-db"] = null; }],
  ["network-membership-permitted", (m) => { m.services["cfmeet-admin"].networks["admin-private"] = null; }],
  ["network-membership-permitted", (m) => { m.services["karryam-admin"].networks["cfmeet-bridge"] = null; }],
  ["network-membership-permitted", (m) => { m.services["product-integration-core"].networks["cfmeet-admin-db"] = null; }],
  ["network-membership-required", (m) => { delete m.services["cfmeet-admin-worker"].networks["cfmeet-bridge"]; }],
  ["socket-reader-read-only", (m) => { m.services["product-integration-core"].volumes[2].read_only = false; }],
  ["socket-reader-group", (m) => { m.services["product-integration-core"].group_add = ["10001"]; }],
  ["socket-writer-uid", (m) => { m.services["cfmeet-admin"].user = "10001:10001"; }],
  ["socket-writer-mount", (m) => { m.services["cfmeet-admin"].volumes[0].read_only = true; }],
  ["socket-not-shared", (m) => { m.services["karryam-admin"].volumes.push({ type: "bind", source: "/srv/cosmicforge/staging/run/cfmeet-admin", target: "/run/cosmicforge/cfmeet", read_only: true }); }],
  ["socket-not-shared", (m) => { m.services["cfmeet-admin"].volumes.push({ type: "bind", source: "/srv/cosmicforge/staging/run/karryam-admin", target: "/run/cosmicforge/karryam", read_only: true }); }],
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

test("policy check refuses HQ or another Product Admin on the CF Meet networks, and missing cross-product denials", () => {
  const p = structuredClone(policy);
  p.networks["cfmeet-bridge"].permitted_members.push("central-admin-api");
  p.networks["cfmeet-admin-db"].permitted_members.push("karryam-admin");
  p.forbidden_flows = p.forbidden_flows.filter((f) => !(f.from === "cfmeet-admin" && f.to === "karryam-admin-db"));
  p.sockets["cfmeet-admin"].readers.push("central-admin-api");
  const failed = failing(checkPolicy(p));
  for (const c of ["policy-bridge-network-excludes-hq", "policy-product-networks-isolated", "policy-forbids-cross-product", "policy-product-socket"]) assert.ok(failed.includes(c), c);
  const q = structuredClone(policy);
  q.sockets["cfmeet-admin"].owner_uid = 10001;
  assert.ok(failing(checkPolicy(q)).includes("policy-socket-uids-unique"));
  const r = structuredClone(policy);
  r.networks["cfmeet-bridge"].default_subnet = r.networks["karryam-bridge"].default_subnet;
  assert.ok(failing(checkPolicy(r)).includes("policy-subnet-unique"));
});

test("firewall check requires the CF Meet subnets", () => {
  const text = fs.readFileSync(path.join(ROOT, "infrastructure/product-admin/firewall/docker-user-rules.sh"), "utf8");
  assert.ok(failing(checkFirewall(text.replaceAll("PA_SUBNET_CMDB", "PA_SUBNET_XX"), policy)).includes("firewall-covers-subnet"));
});

test("nginx check refuses a weakened snippet", () => {
  const text = fs.readFileSync(path.join(ROOT, "infrastructure/product-admin/nginx/internal-deny.conf"), "utf8");
  const failed = (t) => failing(checkNginx(t, policy));
  assert.ok(failed(text.replace("location ~* ^/+_?internal", "location ~ ^/internal")).includes("nginx-denies-internal"));
  assert.ok(failed(text.replace('if ($request_uri ~ "^[^?]*%25") { return 400; }', "")).includes("nginx-refuses-double-encoding"));
  assert.ok(failed(text + "\nlocation ^~ /internal/pic/ { proxy_pass http://unix:/run/x.sock; }\n").includes("nginx-no-proxy-to-private"));
});
