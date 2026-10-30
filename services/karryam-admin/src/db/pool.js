"use strict";

// Dedicated Karryam Admin database (runtime role only). This service never
// connects to Karryam operational/source databases or to the HQ database.

const { Pool } = require("pg");

function createPool(connectionString, { max = 5 } = {}) {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    query_timeout: 6000,
    application_name: "karryam-admin",
  });
  // A broken idle client must not crash the process; the next query fails
  // closed and readiness reports the database as unavailable.
  pool.on("error", () => {});
  return pool;
}

async function ping(pool, timeoutMs = 1500) {
  let timer;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createPool, ping };
