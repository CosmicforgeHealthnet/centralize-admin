"use strict";

// Body search as a keyed blind index (spec 5.1, 12).
//
// Threat model and design (docs/cosmicforge-mail-body-search.md):
// - Bodies stay encrypted in private object storage. No plaintext body, token
//   or snippet is ever written to the database.
// - Each distinct word of a body becomes HMAC-SHA256(mailboxKey, word),
//   truncated to 96 bits (hex). mailboxKey = HMAC(searchKey, mailboxId), so
//   identical words in two mailboxes produce unrelated terms: a database
//   reader cannot correlate content across mailboxes, and a term is useless
//   without the search key, which lives only in the API's secret store.
// - Residual leakage (accepted only behind MAIL_BODY_SEARCH_ENABLED): within
//   one mailbox, a database reader can see how many distinct words a message
//   has and which messages share a (unknown) word. Anyone holding BOTH a
//   database copy and the search key can test guessed words. Rotating the
//   key (new active version + backfill) bounds that exposure.
// - Searches compute terms only for mailboxes the caller is authorized for;
//   authorization is enforced in the SQL (mailbox_id IN ...), never after.
// - Matching is whole-word only (no prefixes), case- and accent-insensitive.

const crypto = require("crypto");

const TERM_BYTES = 12;
const MIN_TOKEN = 2;
const MAX_TOKEN = 40;
const MAX_QUERY_TERMS = 8;

function parseKeyring(keys, activeKey) {
  const map = new Map();
  for (const entry of String(keys || "").split(",").map((value) => value.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator < 1) continue;
    const version = entry.slice(0, separator).trim();
    const key = Buffer.from(entry.slice(separator + 1).trim(), "base64");
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(version) || key.length < 32) continue;
    map.set(version, key);
  }
  const active = activeKey && map.has(activeKey) ? activeKey : [...map.keys()].pop() || null;
  return { keys: map, active };
}

// Lowercase, Unicode-normalized, accent-stripped words of 2-40 characters.
function tokenize(text, limit = 2000) {
  const normalized = String(text || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
  const tokens = new Set();
  for (const token of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < MIN_TOKEN || token.length > MAX_TOKEN) continue;
    tokens.add(token);
    if (tokens.size >= limit) break;
  }
  return [...tokens];
}

function createSearchIndex({ client, config, features, store, audit = null, logger = null, clock = () => new Date() }) {
  const keyring = parseKeyring(config.search.keys, config.search.activeKey);
  const enabled = Boolean(config.search.bodies && keyring.active);
  if (config.search.bodyRequested && !keyring.active) logger?.warn?.("[Mail] MAIL_BODY_SEARCH_ENABLED is set but MAIL_SEARCH_INDEX_KEYS has no valid key (>= 32 bytes); body search stays off.");

  const mailboxKeys = new Map();
  function mailboxKey(version, mailboxId) {
    const cacheKey = `${version}:${mailboxId}`;
    if (!mailboxKeys.has(cacheKey)) {
      if (mailboxKeys.size > 5000) mailboxKeys.clear();
      mailboxKeys.set(cacheKey, crypto.createHmac("sha256", keyring.keys.get(version)).update(`cosmicforge-mail-search:v1:mailbox:${mailboxId}`).digest());
    }
    return mailboxKeys.get(cacheKey);
  }

  function termsFor(version, mailboxId, tokens) {
    const key = mailboxKey(version, mailboxId);
    return tokens.map((token) => crypto.createHmac("sha256", key).update(token, "utf8").digest().subarray(0, TERM_BYTES).toString("hex"));
  }

  async function ready() {
    return enabled && (await features.isReady());
  }

  // Inside the message transaction. Never throws for a disabled index.
  async function indexMessage(tx, { messageId, mailboxId, text }) {
    if (!(await ready())) return false;
    const terms = [...new Set(termsFor(keyring.active, mailboxId, tokenize(text, config.search.maxTermsPerMessage)))];
    await tx.mailMessageSearchIndex.upsert({
      where: { messageId },
      create: { messageId, mailboxId, keyVersion: keyring.active, terms, termCount: terms.length, indexedAt: clock() },
      update: { mailboxId, keyVersion: keyring.active, terms, termCount: terms.length, indexedAt: clock() },
    });
    return true;
  }

  // For each query word: every term it could be stored as in the caller's
  // authorized mailboxes (one per mailbox per key version still in the
  // keyring). Returns null when body search is unavailable.
  async function queryTerms(mailboxIds, query) {
    if (!(await ready())) return null;
    const words = tokenize(query, MAX_QUERY_TERMS);
    if (!words.length) return [];
    return words.map((word) => ({
      word,
      terms: [...keyring.keys.keys()].flatMap((version) => mailboxIds.map((mailboxId) => termsFor(version, mailboxId, [word])[0])),
    }));
  }

  // Messages that have readable content but no index row (or an index built
  // with a key that is no longer active). Bodies are decrypted in-process
  // only to compute terms.
  async function backfill({ limit = config.search.backfillBatch } = {}) {
    if (!(await ready())) return { skipped: "BODY_SEARCH_DISABLED" };
    const rows = await client.$queryRawUnsafe(
      `SELECT m."id", m."mailbox_id" AS "mailboxId", m."content_object_key" AS "contentObjectKey", m."content_sha256" AS "contentSha256"
       FROM "mail_messages" m LEFT JOIN "mail_message_search_index" si ON si."message_id" = m."id"
       WHERE m."deleted_at" IS NULL AND m."content_object_key" IS NOT NULL AND (si."message_id" IS NULL OR si."key_version" <> $1)
       ORDER BY m."created_at" ASC LIMIT $2`,
      keyring.active,
      Math.min(Math.max(Number(limit) || 100, 1), 1000),
    );
    let indexed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const body = await store.readBody(row);
        await client.$transaction(async (tx) => indexMessage(tx, { messageId: row.id, mailboxId: row.mailboxId, text: body.text || "" }));
        indexed += 1;
      } catch (error) {
        failed += 1;
        logger?.warn?.(`[MailSearch] backfill skipped one message (${error?.code || "error"})`);
      }
    }
    const more = rows.length === Math.min(Math.max(Number(limit) || 100, 1), 1000);
    if (audit && (indexed || failed)) await audit.record({ action: "MAIL_SEARCH_INDEX_BACKFILL", targetType: "search_index", outcome: failed ? "PARTIAL" : "SUCCESS", metadata: { indexed, failed, more } });
    return { indexed, failed, more };
  }

  // Index freshness (spec 5.8, 20): how much readable mail is not searchable.
  async function freshness() {
    if (!(await ready())) return { enabled: false, unindexed: null, oldestUnindexedAt: null, staleKeyVersion: null, activeKeyVersion: null };
    const [row] = await client.$queryRawUnsafe(
      `SELECT count(*)::int AS "unindexed", min(m."created_at") AS "oldest",
              count(*) FILTER (WHERE si."message_id" IS NOT NULL)::int AS "stale"
       FROM "mail_messages" m LEFT JOIN "mail_message_search_index" si ON si."message_id" = m."id"
       WHERE m."deleted_at" IS NULL AND m."content_object_key" IS NOT NULL AND (si."message_id" IS NULL OR si."key_version" <> $1)`,
      keyring.active,
    );
    return { enabled: true, unindexed: row?.unindexed || 0, oldestUnindexedAt: row?.oldest ? new Date(row.oldest).toISOString() : null, staleKeyVersion: row?.stale || 0, activeKeyVersion: keyring.active };
  }

  return { enabled, ready, indexMessage, queryTerms, backfill, freshness, tokenize };
}

module.exports = { createSearchIndex, tokenize, parseKeyring, TERM_BYTES };
