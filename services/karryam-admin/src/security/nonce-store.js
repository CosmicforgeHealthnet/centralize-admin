"use strict";

// Durable replay protection for service-request nonces and delegation JTIs.
// Claims are atomic (primary-key insert) and survive restarts/replicas.
// Infrastructure failure throws, and the protocol kit fails the request
// closed; there is never an in-memory fallback in production.

const NAMESPACE = /^[a-z][a-z0-9:._-]{0,95}$/;
const NONCE = /^[A-Za-z0-9._:-]{8,128}$/;

function pgNonceStore(pool, { now = Date.now, cleanupEvery = 500 } = {}) {
  let claims = 0;
  return {
    async claim(namespace, nonce, expiresAtMs) {
      if (!NAMESPACE.test(String(namespace)) || !NONCE.test(String(nonce)) || !Number.isFinite(expiresAtMs)) return false;
      const result = await pool.query(
        "INSERT INTO karryam_admin.request_nonces(namespace, nonce, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0)) ON CONFLICT DO NOTHING",
        [namespace, nonce, Math.max(expiresAtMs, now())],
      );
      claims += 1;
      if (claims % cleanupEvery === 0) {
        pool.query("DELETE FROM karryam_admin.request_nonces WHERE expires_at < now() - interval '5 minutes'").catch(() => {});
      }
      return result.rowCount === 1;
    },
  };
}

function memoryNonceStore() {
  const seen = new Set();
  return {
    async claim(namespace, nonce) {
      const key = namespace + "\n" + nonce;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

module.exports = { pgNonceStore, memoryNonceStore };
