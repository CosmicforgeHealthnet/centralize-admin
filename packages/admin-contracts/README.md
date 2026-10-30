# @cosmicforge/admin-contracts

Universal Product Admin Protocol **v1** contract library (Node.js 22, no runtime
dependencies). Used by every Product Admin and by Headquarters.

| Module | Provides |
|---|---|
| `protocol.js` | Protocol version, base path `/internal/product-admin/v1`, the fixed 12-endpoint table (`ENDPOINTS`, `endpointPath`, `matchEndpoint`), enums (capability states, freshness, coverage, privacy classes, scope dimensions), error codes |
| `schemas.js` → `schemas/*.json` | JSON schemas: manifest, signed manifest, capability, dataset, event family, response envelope, metric observation, events ACK, operation command, events page, sync status, snapshot |
| `validator.js` | Strict JSON-schema subset validator (unsupported keywords throw) |
| `manifest.js` | Ed25519 manifest signing and verification against an operator trust store and registry expectations |
| `catalog.js` | Catalog semantics, dataset schema digests, catalog digest, standard metric observation event family |
| `compatibility.js` | Semantic versioning and catalog comparison (`IDENTICAL` / `COMPATIBLE_ADDITIVE` / `BREAKING`), activation decision |
| `envelope.js` | Standard response envelope, truthfulness rules, `ProtocolError`, metric observation checks |
| `params.js` | Strict query parsing and pagination |
| `testing.js` | Test-only fixtures (ephemeral keys); never used for real trust enrollment |

Machine-readable contract: `openapi/product-admin-protocol-v1.openapi.json`.
After editing `src/schemas.js` or `src/protocol.js`, run `npm run schemas:write`;
tests fail if the published files drift. See
[docs/product-admin/protocol-v1.md](../../docs/product-admin/protocol-v1.md).

```bash
npm test
```

Consumers in this monorepo require the package by relative path
(`require("../../packages/admin-contracts")`); service images copy `packages/`
with the same relative layout.
