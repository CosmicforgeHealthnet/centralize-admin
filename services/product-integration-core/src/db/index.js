"use strict";

const T = "hq_integration.";

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Durable replay store (delegation JTIs, nonces). Survives restarts and is
// shared by replicas; an unavailable store denies rather than trusting memory.
function createNonceStore(pool) {
  return {
    async claim(namespace, nonce, expiresAtMs) {
      await pool.query(`DELETE FROM ${T}hq_product_admin_replay_nonces WHERE expires_at < now() - interval '5 minutes'`).catch(() => {});
      const { rowCount } = await pool.query(
        `INSERT INTO ${T}hq_product_admin_replay_nonces (namespace, nonce, expires_at) VALUES ($1, $2, to_timestamp($3::double precision / 1000)) ON CONFLICT DO NOTHING`,
        [String(namespace).slice(0, 128), String(nonce).slice(0, 128), expiresAtMs]);
      return rowCount === 1;
    },
  };
}

module.exports = { T, withTx, createNonceStore };
