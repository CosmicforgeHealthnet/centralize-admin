require("dotenv").config({ quiet: true });

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const https = require("https");
const net = require("net");
const dns = require("dns").promises;
const axios = require("axios");

const guard = require("./helpers/network-guard");
const {
  fetchDailyCampaignInsights,
} = require("../src/modules/marketing/intelligence/connectors/meta.connector");
const {
  fetchRemoteMediaSafely,
} = require("../src/modules/marketing/social-operations/security/ssrf-safe-fetch.service");

guard.resetStats();

function hasGuardCode(error) {
  if (!error) return false;
  if (error.code === guard.BLOCK_CODE) return true;
  if (String(error.message || "").includes(guard.BLOCK_CODE)) return true;
  if (error.cause && hasGuardCode(error.cause)) return true;
  if (Array.isArray(error.errors)) return error.errors.some(hasGuardCode);
  return false;
}

function assertSanitized(error) {
  const text = `${error?.message || ""} ${error?.stack || ""}`;
  assert.equal(text.includes("fake-token"), false);
  assert.equal(text.includes("Bearer fake"), false);
  assert.equal(text.includes("fake-body"), false);
  assert.equal(text.includes("access_token="), false);
  assert.equal(text.includes("code="), false);
  assert.equal(text.includes("user:pass"), false);
}

async function rejectsWithGuard(fn) {
  try {
    await (typeof fn === "function" ? fn() : fn);
  } catch (error) {
    assert.equal(hasGuardCode(error), true, error?.message);
    assertSanitized(error);
    return error;
  }
  assert.fail("Expected the network guard to block the request");
}

function throwsWithGuard(fn) {
  try {
    fn();
  } catch (error) {
    assert.equal(hasGuardCode(error), true, error?.message);
    assertSanitized(error);
    return error;
  }
  assert.fail("Expected the network guard to block the request");
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on("error", reject);
  });
}

test("external global fetch is blocked with sanitized diagnostics", async () => {
  const tokenParam = ["access", "token"].join("_");
  const blockedUrl = new URL("https://example.com/path");
  blockedUrl.searchParams.set(tokenParam, "fake-token");
  blockedUrl.searchParams.set("code", "fake-code");
  const error = await rejectsWithGuard(() =>
    fetch(blockedUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: "Bearer fake",
        Cookie: "session=fake-token",
      },
      body: "fake-body",
    }),
  );
  assert.match(error.message, /api=fetch/);
  assert.match(error.message, /host=example\.com/);
  assert.match(error.message, /path=\/path/);
});

test("external built-in HTTP request is blocked before DNS or socket access", () => {
  throwsWithGuard(() => http.get("http://example.com/plain"));
});

test("external built-in HTTPS request is blocked before DNS or socket access", () => {
  throwsWithGuard(() => https.get("https://example.com/secure"));
});

test("external public IPv4 request is blocked", () => {
  throwsWithGuard(() => http.get("http://93.184.216.34/"));
});

test("external public IPv6 request is blocked", () => {
  throwsWithGuard(() => http.get("http://[2606:4700:4700::1111]/"));
});

test("cloud metadata endpoint request is blocked", () => {
  throwsWithGuard(() => http.get("http://169.254.169.254/latest/meta-data"));
});

test("Meta API hostname is blocked", async () => {
  await rejectsWithGuard(() => fetch("https://graph.facebook.com/v25.0/me"));
  await rejectsWithGuard(() => fetch("https://graph.instagram.com/me"));
});

test("TikTok API hostnames are blocked", async () => {
  await rejectsWithGuard(() => fetch("https://api.tiktok.com/v2/user/info/"));
  await rejectsWithGuard(() => fetch("https://open.tiktokapis.com/v2/post/publish/"));
  await rejectsWithGuard(() => fetch("https://business-api.tiktok.com/open_api/v1.3/report/task/"));
});

test("X API hostnames are blocked", async () => {
  await rejectsWithGuard(() => fetch("https://api.x.com/2/tweets"));
  await rejectsWithGuard(() => fetch("https://api.twitter.com/2/tweets"));
  await rejectsWithGuard(() => fetch("https://upload.twitter.com/1.1/media/upload.json"));
});

test("LinkedIn API hostnames are blocked", async () => {
  await rejectsWithGuard(() => fetch("https://api.linkedin.com/rest/posts"));
  await rejectsWithGuard(() => fetch("https://www.linkedin.com/oauth/v2/accessToken"));
});

test("Cloudinary API hostnames are blocked", async () => {
  await rejectsWithGuard(() => fetch("https://api.cloudinary.com/v1_1/demo/image/upload"));
  await rejectsWithGuard(() => fetch("https://res.cloudinary.com/demo/image/upload/sample.jpg"));
});

test("arbitrary remote media URL is blocked when a real fetch transport is accidentally used", async () => {
  await rejectsWithGuard(() =>
    fetchRemoteMediaSafely({
      url: "https://media.example.test/image.png",
      allowedHosts: ["media.example.test"],
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      fetcher: fetch,
      allowedContentTypes: ["image/png"],
    }),
  );
});

test("URLs with embedded credentials are rejected without exposing credentials", async () => {
  await rejectsWithGuard(() => fetch("https://user:pass@example.com/private"));
});

test("hostnames that merely end with localhost are blocked", async () => {
  await rejectsWithGuard(() => fetch("https://localhost.example.com/"));
  await rejectsWithGuard(() => fetch("https://127.0.0.1.example.com/"));
});

test("axios external request is blocked through the Node HTTP transport", async () => {
  await rejectsWithGuard(() =>
    axios.get("https://example.com/axios?access_token=fake-token", {
      headers: { Authorization: "Bearer fake" },
      data: "fake-body",
    }),
  );
});

test("direct undici usage is blocked when the module is available, otherwise global fetch covers the runtime path", async () => {
  let undici;
  try {
    undici = require("undici");
  } catch {
    assert.equal(guard.stats().undiciPatched, false);
    await rejectsWithGuard(() => fetch("https://example.com/undici-runtime"));
    return;
  }
  await rejectsWithGuard(() => undici.request("https://example.com/undici"));
});

test("disabled provider flags do not create a network bypass", async () => {
  await withEnv({ META_SOCIAL_ENABLED: "false" }, async () => {
    await rejectsWithGuard(() => fetch("https://graph.facebook.com/v25.0/me"));
  });
});

test("accidentally enabled provider flags do not create a network bypass", async () => {
  await withEnv({ META_SOCIAL_ENABLED: "true" }, async () => {
    await rejectsWithGuard(() => fetch("https://graph.facebook.com/v25.0/me"));
  });
});

test("direct provider client call cannot bypass the guard", async () => {
  await withEnv(
    {
      META_ACCESS_TOKEN: "fake-token",
      META_AD_ACCOUNT_ID: "1234567890",
      MARKETING_PROVIDER_MAX_RETRIES: "0",
    },
    async () => {
      await rejectsWithGuard(() =>
        fetchDailyCampaignInsights({
          since: "2026-07-01",
          until: "2026-07-01",
        }),
      );
    },
  );
});

test("direct Cloudinary client call cannot bypass the guard", async () => {
  const cloudinary = require("cloudinary").v2;
  cloudinary.config({
    cloud_name: "demo",
    api_key: "synthetic-key",
    api_secret: "fake",
    secure: true,
  });
  await rejectsWithGuard(() => cloudinary.api.ping());
});

test("redirect from an allowed local server to an external host is blocked", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(302, { Location: "https://example.com/redirected?access_token=fake-token" });
    response.end();
  });
  const address = await listen(server);
  try {
    await rejectsWithGuard(() => fetch(`http://127.0.0.1:${address.port}/start`));
  } finally {
    await close(server);
  }
});

test("external DNS lookup is blocked", async () => {
  await rejectsWithGuard(() => dns.lookup("example.com"));
});

test("localhost HTTP mock server is allowed", async () => {
  const server = http.createServer((request, response) => response.end("localhost-ok"));
  const address = await listen(server, "localhost");
  try {
    const response = await httpGet(`http://localhost:${address.port}/local`);
    assert.equal(response.body, "localhost-ok");
  } finally {
    await close(server);
  }
});

test("127.0.0.1 HTTP mock server is allowed", async () => {
  const server = http.createServer((request, response) => response.end("loopback-ok"));
  const address = await listen(server, "127.0.0.1");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/loopback`);
    assert.equal(await response.text(), "loopback-ok");
  } finally {
    await close(server);
  }
});

test("::1 HTTP mock server is allowed when the environment supports IPv6 loopback", async (t) => {
  const server = http.createServer((request, response) => response.end("ipv6-ok"));
  let address;
  try {
    address = await listen(server, "::1");
  } catch (error) {
    t.skip(`IPv6 loopback unavailable: ${error.code || error.message}`);
    return;
  }
  try {
    const response = await fetch(`http://[::1]:${address.port}/ipv6`);
    assert.equal(await response.text(), "ipv6-ok");
  } finally {
    await close(server);
  }
});

test("configured PostgreSQL destination is allowed without exposing credentials", async (t) => {
  const destination = guard.parseDatabaseDestination();
  if (!destination) {
    t.skip("No approved local DATABASE_URL is configured");
    return;
  }
  await new Promise((resolve, reject) => {
    const socket = net.connect(destination.port, destination.host, () => {
      socket.destroy();
      resolve();
    });
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("Timed out connecting to configured PostgreSQL destination"));
    });
    socket.on("error", reject);
  });
});

test("wrong PostgreSQL port is blocked before a socket opens", (t) => {
  const destination = guard.parseDatabaseDestination();
  if (!destination) {
    t.skip("No approved local DATABASE_URL is configured");
    return;
  }
  throwsWithGuard(() => net.connect(destination.port + 17, destination.host));
});

test("unregistered local ports are blocked by policy", () => {
  throwsWithGuard(() => net.connect(65534, "127.0.0.1"));
});

test("network guard stats record deliberate blocked and allowed runtime checks", () => {
  const current = guard.stats();
  console.log(`network-guard-stats blocked=${current.blocked} allowed_local=${current.allowedLocal}`);
  assert.ok(current.blocked >= 27, `blocked=${current.blocked}`);
  assert.ok(current.allowedLocal >= 5, `allowedLocal=${current.allowedLocal}`);
});
