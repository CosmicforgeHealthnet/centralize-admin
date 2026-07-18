# Social Operations CI Network Guard

## Purpose

The automated test runtime installs a centralized network guard before test files import application, provider, Cloudinary, or media modules. Provider flags, worker flags, and mock configuration reduce expected network usage, but they do not prove that an accidental direct SDK or HTTP call cannot escape. The guard closes that gap by blocking unexpected outbound traffic during ordinary tests and CI.

## Runtime Coverage

The guard is loaded from `tests/helpers/network-guard.js` with Node's `--require` option. It patches:

- `globalThis.fetch`
- `http.request` and `http.get`
- `https.request` and `https.get`
- `net.connect` and `net.createConnection`
- `tls.connect`
- `dns.lookup`, `dns.promises.lookup`, and `dns.resolve`
- direct `undici` APIs when the module is available

Axios, provider SDKs, and the Cloudinary SDK are covered through the HTTP/HTTPS and socket layers. Node's built-in fetch runtime is covered by the fetch wrapper, with socket-level protection as a second layer.

## Allowed Local Connections

Tests may connect only to approved local destinations:

- `localhost`
- `127.0.0.1`
- `::1`
- the configured local PostgreSQL host and port from `DATABASE_URL`
- ephemeral local HTTP servers that are registered automatically when `net.Server.listen()` succeeds

Unregistered local ports are blocked. This keeps local Express route tests working while preventing arbitrary local or external TCP connections.

## PostgreSQL Exception

The guard parses `DATABASE_URL` at runtime and allows only its exact host and port when the host is local or the explicitly configured CI service host `postgres`. It never logs the database URL or password. A wrong PostgreSQL port is blocked before socket creation.

## Sanitized Error Format

Blocked requests throw `UNEXPECTED_EXTERNAL_NETWORK_REQUEST` with safe fields only:

```text
UNEXPECTED_EXTERNAL_NETWORK_REQUEST api=fetch method=GET host=api.example.com path=/path
```

The error never includes query strings, fragments, authorization headers, cookies, request bodies, credentials, OAuth codes, signatures, or full private URLs.

## CI Integration

`.github/workflows/social-operations-ci.yml` sets `TEST_NETWORK_GUARD_ENABLED=true`, runs `npm run test:network-guard`, then runs focused Social Operations tests and the full `npm test` with the guard active. Live provider flags, workers, Phase D, and the live inbox remain disabled.

## Negative Runtime Tests

`tests/network-guard.test.js` deliberately attempts blocked requests through fetch, HTTP, HTTPS, axios, provider client code, Cloudinary client code, DNS lookup, external IPv4/IPv6, cloud metadata IP, provider domains, Cloudinary domains, arbitrary media URLs, embedded credentials, and an external redirect from an allowed local server.

## Positive Runtime Tests

The same test file proves local mock servers on `localhost`, `127.0.0.1`, and `::1` where supported remain usable, the configured PostgreSQL destination remains reachable, and unregistered local ports are blocked.

## Adding New Mocked Providers

New provider tests should inject mocks or use local mock servers. Do not allow provider domains in the guard, and do not add broad host wildcards. A real live sandbox test must use a separate explicit command and exact host allow-list; ordinary `npm test` must continue blocking external traffic.

## Live Verification

This guard verifies backend test and CI runtime safety. It does not perform or claim live provider verification, real Cloudinary upload verification, staging deployment, or production readiness.
