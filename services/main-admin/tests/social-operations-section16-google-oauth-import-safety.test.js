const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");

const { closeServer } = require("./helpers/server-close");

const ROOT = path.resolve(__dirname, "..");
const GOOGLE_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
];
const CLOUDINARY_ENV = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

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

function optionalIntegrationEnv(extra = {}) {
  return {
    NODE_ENV: "test",
    APP_ENV: undefined,
    ...Object.fromEntries(GOOGLE_ENV.map((name) => [name, undefined])),
    ...Object.fromEntries(CLOUDINARY_ENV.map((name) => [name, undefined])),
    ...extra,
  };
}

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function clearAppModule() {
  clearModule("../src/app");
}

function clearGoogleModule() {
  clearModule("../src/shared/config/google.strategy");
}

function removeDefaultGoogleStrategy() {
  const passport = require("passport");
  if (typeof passport.unuse === "function") {
    try {
      passport.unuse("google");
    } catch {
      // Passport throws when removing an unregistered strategy in some versions.
    }
  } else if (passport._strategies) {
    delete passport._strategies.google;
  }
}

function requireFreshGoogleModule() {
  removeDefaultGoogleStrategy();
  clearGoogleModule();
  return require("../src/shared/config/google.strategy");
}

function requireFreshApp() {
  removeDefaultGoogleStrategy();
  clearAppModule();
  return require("../src/app");
}

function createFakePassport() {
  const strategies = new Map();
  return {
    use(name, strategy) {
      strategies.set(name, strategy);
      return this;
    },
    _strategy(name) {
      return strategies.get(name);
    },
    initialize() {
      return (req, res, next) => next();
    },
  };
}

function validGoogleEnv(extra = {}) {
  return {
    NODE_ENV: "test",
    GOOGLE_CLIENT_ID: "unit-client",
    GOOGLE_CLIENT_SECRET: "unit-secret",
    GOOGLE_CALLBACK_URL: "http://127.0.0.1:4000/api/auth/google/callback",
    ...extra,
  };
}

async function listen(app) {
  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve(server));
  });
}

test("Google strategy module imports with no credentials", async () => {
  await withEnv(optionalIntegrationEnv(), () => {
    assert.doesNotThrow(() => requireFreshGoogleModule());
  });
});

test("both Google credentials absent produces disabled status", () => {
  const google = requireFreshGoogleModule();
  const status = google.resolveGoogleOAuthConfig({ env: { NODE_ENV: "test" } });
  assert.equal(status.configured, false);
  assert.equal(status.reasonCode, "GOOGLE_OAUTH_NOT_CONFIGURED");
});

test("client ID only fails safely", () => {
  const google = requireFreshGoogleModule();
  assert.throws(
    () =>
      google.resolveGoogleOAuthConfig({
        env: { NODE_ENV: "test", GOOGLE_CLIENT_ID: "client-only" },
      }),
    (error) => {
      assert.equal(error.reasonCode, "GOOGLE_OAUTH_CONFIGURATION_INCOMPLETE");
      assert.equal(JSON.stringify(error).includes("client-only"), false);
      assert.deepEqual(
        error.issues.map((item) => item.variable).sort(),
        ["GOOGLE_CALLBACK_URL", "GOOGLE_CLIENT_SECRET"],
      );
      return true;
    },
  );
});

test("client secret only fails safely", () => {
  const google = requireFreshGoogleModule();
  assert.throws(
    () =>
      google.resolveGoogleOAuthConfig({
        env: { NODE_ENV: "test", GOOGLE_CLIENT_SECRET: "secret-only" },
      }),
    (error) => {
      assert.equal(error.reasonCode, "GOOGLE_OAUTH_CONFIGURATION_INCOMPLETE");
      assert.equal(JSON.stringify(error).includes("secret-only"), false);
      assert.deepEqual(
        error.issues.map((item) => item.variable).sort(),
        ["GOOGLE_CALLBACK_URL", "GOOGLE_CLIENT_ID"],
      );
      return true;
    },
  );
});

test("missing callback with both credentials fails safely", () => {
  const google = requireFreshGoogleModule();
  assert.throws(
    () =>
      google.resolveGoogleOAuthConfig({
        env: {
          NODE_ENV: "test",
          GOOGLE_CLIENT_ID: "unit-client",
          GOOGLE_CLIENT_SECRET: "unit-secret",
        },
      }),
    /GOOGLE_OAUTH_CONFIGURATION_INCOMPLETE/,
  );
});

test("valid complete configuration registers GoogleStrategy", () => {
  const google = requireFreshGoogleModule();
  const constructed = [];
  class FakeStrategy {
    constructor(options, verify) {
      constructed.push({ options, verify });
    }
  }

  const passport = createFakePassport();
  const status = google.configureGoogleStrategy({
    passport,
    env: validGoogleEnv(),
    Strategy: FakeStrategy,
    db: {},
  });

  assert.equal(status.configured, true);
  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].options.clientID, "unit-client");
  assert.equal(constructed[0].options.clientSecret, "unit-secret");
  assert.equal(
    constructed[0].options.callbackURL,
    "http://127.0.0.1:4000/api/auth/google/callback",
  );
  assert.equal(passport._strategy("google") instanceof FakeStrategy, true);
});

test("Google strategy registration is idempotent", () => {
  const google = requireFreshGoogleModule();
  let constructions = 0;
  class FakeStrategy {
    constructor() {
      constructions += 1;
    }
  }
  const passport = createFakePassport();

  const first = google.configureGoogleStrategy({
    passport,
    env: validGoogleEnv(),
    Strategy: FakeStrategy,
    db: {},
  });
  const second = google.configureGoogleStrategy({
    passport,
    env: validGoogleEnv(),
    Strategy: FakeStrategy,
    db: {},
  });

  assert.equal(constructions, 1);
  assert.equal(first.alreadyRegistered, false);
  assert.equal(second.alreadyRegistered, true);
});

test("valid Google configuration registration does not make a network request", () => {
  const google = requireFreshGoogleModule();
  let outboundCalls = 0;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalNetConnect = net.connect;
  const originalTlsConnect = tls.connect;

  http.request = function patchedHttpRequest() {
    outboundCalls += 1;
    throw new Error("unexpected http request");
  };
  https.request = function patchedHttpsRequest() {
    outboundCalls += 1;
    throw new Error("unexpected https request");
  };
  net.connect = function patchedNetConnect() {
    outboundCalls += 1;
    throw new Error("unexpected socket");
  };
  tls.connect = function patchedTlsConnect() {
    outboundCalls += 1;
    throw new Error("unexpected tls socket");
  };

  try {
    class FakeStrategy {}
    google.configureGoogleStrategy({
      passport: createFakePassport(),
      env: validGoogleEnv(),
      Strategy: FakeStrategy,
      db: {},
    });
    assert.equal(outboundCalls, 0);
  } finally {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    net.connect = originalNetConnect;
    tls.connect = originalTlsConnect;
  }
});

test("invalid callback URL fails", () => {
  const google = requireFreshGoogleModule();
  assert.throws(
    () =>
      google.resolveGoogleOAuthConfig({
        env: validGoogleEnv({ GOOGLE_CALLBACK_URL: "not a url" }),
      }),
    /GOOGLE_OAUTH_CALLBACK_INVALID/,
  );
});

test("callback URL rejects wildcard, fragments, and sensitive query parameters", () => {
  const google = requireFreshGoogleModule();
  for (const callbackURL of [
    "https://*.example.test/api/auth/google/callback",
    "https://admin.example.test/api/auth/google/callback#fragment",
    "https://admin.example.test/api/auth/google/callback?code=abc",
  ]) {
    assert.throws(
      () =>
        google.resolveGoogleOAuthConfig({
          env: validGoogleEnv({ GOOGLE_CALLBACK_URL: callbackURL }),
        }),
      /GOOGLE_OAUTH_CALLBACK_INVALID/,
    );
  }
});

test("request-controlled headers cannot alter callback URL", () => {
  const google = requireFreshGoogleModule();
  const constructed = [];
  class FakeStrategy {
    constructor(options) {
      constructed.push(options);
    }
  }

  google.configureGoogleStrategy({
    passport: createFakePassport(),
    env: validGoogleEnv({
      GOOGLE_CALLBACK_URL: "https://admin.example.test/api/auth/google/callback",
    }),
    Strategy: FakeStrategy,
    db: {},
  });

  assert.equal(
    constructed[0].callbackURL,
    "https://admin.example.test/api/auth/google/callback",
  );
});

test("production and staging keep Google optional but reject unsafe configured callbacks", () => {
  const google = requireFreshGoogleModule();
  assert.equal(
    google.resolveGoogleOAuthConfig({ env: { NODE_ENV: "production" } }).configured,
    false,
  );
  assert.throws(
    () =>
      google.resolveGoogleOAuthConfig({
        env: validGoogleEnv({ NODE_ENV: "production" }),
      }),
    /GOOGLE_OAUTH_CALLBACK_INVALID/,
  );
  assert.equal(
    google.resolveGoogleOAuthConfig({
      env: validGoogleEnv({
        NODE_ENV: "staging",
        GOOGLE_CALLBACK_URL: "https://admin.example.test/api/auth/google/callback",
      }),
    }).configured,
    true,
  );
});

test("no Google credential value appears in configuration errors or logs", () => {
  const google = requireFreshGoogleModule();
  const logs = [];
  const logger = { info: (message) => logs.push(String(message)) };

  assert.throws(
    () =>
      google.resolveGoogleOAuthConfig({
        env: {
          NODE_ENV: "test",
          GOOGLE_CLIENT_ID: "do-not-leak-client",
        },
      }),
    (error) => {
      const serialized = `${error.message} ${JSON.stringify(error.issues)}`;
      assert.equal(serialized.includes("do-not-leak-client"), false);
      return true;
    },
  );

  class FakeStrategy {}
  google.configureGoogleStrategy({
    passport: createFakePassport(),
    env: validGoogleEnv({
      GOOGLE_CALLBACK_URL: "https://admin.example.test/api/auth/google/callback?state=opaque",
    }),
    logger,
    Strategy: FakeStrategy,
    db: {},
  });
  assert.equal(logs.join("\n").includes("unit-secret"), false);
  assert.equal(logs.join("\n").includes("state=opaque"), false);
});

test("app module imports with no Google credentials", async () => {
  await withEnv(optionalIntegrationEnv(), () => {
    assert.doesNotThrow(() => requireFreshApp());
  });
});

test("app factory creates successfully with Google OAuth disabled", async () => {
  await withEnv(optionalIntegrationEnv(), () => {
    const appModule = requireFreshApp();
    const app = appModule.createApp({
      env: process.env,
      appLogger: { info() {}, warn() {} },
    });
    assert.equal(app.locals.googleOAuth.configured, false);
    assert.equal(app.locals.googleOAuth.reasonCode, "GOOGLE_OAUTH_NOT_CONFIGURED");
  });
});

test("partial Google configuration fails before traffic is served", async () => {
  await withEnv(
    optionalIntegrationEnv({
      GOOGLE_CLIENT_ID: "partial-client",
    }),
    () => {
      assert.throws(() => requireFreshApp(), /GOOGLE_OAUTH_CONFIGURATION_INCOMPLETE/);
    },
  );
});

test("application import does not start listening", async () => {
  await withEnv(optionalIntegrationEnv(), () => {
    const originalListen = http.Server.prototype.listen;
    let listenCalls = 0;
    http.Server.prototype.listen = function patchedListen(...args) {
      listenCalls += 1;
      return originalListen.apply(this, args);
    };
    try {
      requireFreshApp();
      assert.equal(listenCalls, 0);
    } finally {
      http.Server.prototype.listen = originalListen;
    }
  });
});

test("application import does not open a network socket", async () => {
  await withEnv(optionalIntegrationEnv(), () => {
    let outboundCalls = 0;
    const originalHttpRequest = http.request;
    const originalHttpsRequest = https.request;
    const originalNetConnect = net.connect;
    const originalTlsConnect = tls.connect;

    http.request = function patchedHttpRequest() {
      outboundCalls += 1;
      throw new Error("unexpected http request");
    };
    https.request = function patchedHttpsRequest() {
      outboundCalls += 1;
      throw new Error("unexpected https request");
    };
    net.connect = function patchedNetConnect() {
      outboundCalls += 1;
      throw new Error("unexpected socket");
    };
    tls.connect = function patchedTlsConnect() {
      outboundCalls += 1;
      throw new Error("unexpected tls socket");
    };

    try {
      requireFreshApp();
      assert.equal(outboundCalls, 0);
    } finally {
      http.request = originalHttpRequest;
      https.request = originalHttpsRequest;
      net.connect = originalNetConnect;
      tls.connect = originalTlsConnect;
    }
  });
});

test("application import does not start workers", async () => {
  await withEnv(optionalIntegrationEnv({ SOCIAL_WORKERS_ENABLED: "true" }), () => {
    const workerRunner = require.resolve(
      "../src/modules/marketing/social-operations/workers/social-worker-runner",
    );
    delete require.cache[workerRunner];
    requireFreshApp();
    assert.equal(require.cache[workerRunner], undefined);
  });
});

test("application import does not start timers", async () => {
  await withEnv(optionalIntegrationEnv(), () => {
    const originalSetInterval = global.setInterval;
    const originalSetTimeout = global.setTimeout;
    let timers = 0;
    global.setInterval = function patchedSetInterval(...args) {
      timers += 1;
      return originalSetInterval.apply(this, args);
    };
    global.setTimeout = function patchedSetTimeout(...args) {
      timers += 1;
      return originalSetTimeout.apply(this, args);
    };
    try {
      requireFreshApp();
      assert.equal(timers, 0);
    } finally {
      global.setInterval = originalSetInterval;
      global.setTimeout = originalSetTimeout;
    }
  });
});

test("disabled Google route returns safe 503 instead of unknown strategy", async () => {
  await withEnv(optionalIntegrationEnv(), async () => {
    const app = requireFreshApp();
    const server = await listen(app);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${baseUrl}/api/auth/google`, { redirect: "manual" });
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.deepEqual(body, {
        success: false,
        code: "GOOGLE_OAUTH_NOT_CONFIGURED",
        message: "Google authentication is currently unavailable.",
      });
    } finally {
      await closeServer(server);
    }
  });
});

test("disabled Google callback route returns safe 503", async () => {
  await withEnv(optionalIntegrationEnv(), async () => {
    const app = requireFreshApp();
    const server = await listen(app);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${baseUrl}/api/auth/google/callback?code=unit`, {
        redirect: "manual",
      });
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.code, "GOOGLE_OAUTH_NOT_CONFIGURED");
    } finally {
      await closeServer(server);
    }
  });
});

test("JWT/password auth remains available when Google OAuth is disabled", async () => {
  await withEnv(optionalIntegrationEnv(), async () => {
    const app = requireFreshApp();
    const server = await listen(app);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.success, false);
      assert.notEqual(body.code, "GOOGLE_OAUTH_NOT_CONFIGURED");
    } finally {
      await closeServer(server);
    }
  });
});

test("observability route imports and runs without Google credentials", async () => {
  await withEnv(optionalIntegrationEnv(), async () => {
    const app = requireFreshApp();
    const server = await listen(app);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${baseUrl}/api/v1/marketing/social/operations/health`);
      assert.equal(response.status, 401);
    } finally {
      await closeServer(server);
    }
  });
});

test("Section 8 routes import and run without Google credentials", async () => {
  await withEnv(optionalIntegrationEnv(), async () => {
    const app = requireFreshApp();
    const server = await listen(app);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const root = await fetch(`${baseUrl}/api/v1/marketing/social`);
      const webhook = await fetch(`${baseUrl}/api/v1/marketing/social/webhooks/META`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(root.status, 401);
      assert.equal(webhook.status, 401);
    } finally {
      await closeServer(server);
    }
  });
});

test("undefined server cleanup succeeds", async () => {
  await assert.doesNotReject(() => closeServer(undefined));
});

test("already-closed server cleanup succeeds", async () => {
  const server = http.createServer((request, response) => response.end("ok"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await closeServer(server);
  await assert.doesNotReject(() => closeServer(server));
});

test("close callback errors are surfaced", async () => {
  const error = new Error("close failed");
  await assert.rejects(
    () =>
      closeServer({
        listening: true,
        close(callback) {
          callback(error);
        },
      }),
    /close failed/,
  );
});

test("optional-integration static import-safety test passes", () => {
  const googleSource = fs.readFileSync(
    path.join(ROOT, "src", "shared", "config", "google.strategy.js"),
    "utf8",
  );
  const appSource = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const cloudinarySource = fs.readFileSync(
    path.join(ROOT, "src", "shared", "config", "cloudinary.js"),
    "utf8",
  );

  assert.doesNotMatch(googleSource, /new\s+GoogleStrategy\s*\(/);
  assert.doesNotMatch(googleSource, /passport\.use\s*\(\s*new\s+Strategy/);
  assert.match(googleSource, /function configureGoogleStrategy/);
  assert.match(appSource, /configureGoogleStrategy/);
  assert.doesNotMatch(cloudinarySource, /cloudinary\.config\s*\(/);
  assert.match(cloudinarySource, /function configureCloudinary/);
});
