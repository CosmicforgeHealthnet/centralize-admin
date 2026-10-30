# @cosmicforge/event-contracts

Standard **Product Admin → HQ** event envelope v1 (`schemas/event-envelope.v1.json`),
registry validation and sequencing helpers. No runtime dependencies besides the
sibling `admin-contracts` package.

- `createEvent`, `payloadDigest`, `eventDigest` — envelope construction and digests.
- `createEventRegistry({ productId, sourceId, families, datasets })` — validates
  product/source identity, family and schema version (drift), certification and
  sunset, dataset binding, classification (restricted personal data refused),
  payload digest and schema, metric observation truthfulness, scope dimensions
  and allowed scope, timestamps. Returns stable reason codes for quarantine.
- `sequenceDecision(last, seq)` → `NEXT` | `ALREADY_SEEN` | `GAP`.
- `entityVersionDecision(current, incoming)` → `APPLY` | `SAME` | `STALE`.

This is **not** the Karryam Bridge source-event contract. Bridge events are
consumed inside Karryam Admin (later phase) and translated into this envelope;
the two are never interchangeable (a test asserts a bridge-shaped event is
rejected).

```bash
npm test
```
