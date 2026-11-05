"use strict";

// Section 9.5 migration discipline helpers and Section 11.4 prohibited
// fields (product-neutral).

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("..");

const MS = C.migrationSafety;

test("statement splitting respects comments, quotes and dollar-quoted bodies", () => {
  const sql = `-- comment; with semicolon
CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'a;b'; END; $$;
/* block; comment */ INSERT INTO s.t (v) VALUES ('it''s; fine');
ALTER TABLE s.t ADD COLUMN c int`;
  const parts = MS.splitStatements(sql);
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^CREATE FUNCTION[\s\S]*END; \$\$$/);
  assert.match(parts[1], /it''s; fine/);
});

test("risk analysis classifies destructive, rewriting, validating and blocking statements", () => {
  const kinds = (sql) => MS.analyzeSql(sql).map((a) => a.kind);
  assert.deepEqual(kinds("DROP TABLE s.t"), ["DESTRUCTIVE"]);
  assert.deepEqual(kinds("ALTER TABLE s.t DROP COLUMN c"), ["DESTRUCTIVE"]);
  assert.deepEqual(kinds("DELETE FROM s.t"), ["DATA_REMOVAL"]);
  assert.deepEqual(kinds("CREATE EXTENSION pgcrypto"), ["EXTENSION_REQUIRED"]);
  assert.deepEqual(kinds("ALTER TABLE s.t ADD COLUMN g text GENERATED ALWAYS AS (x) STORED"), ["TABLE_REWRITE"]);
  assert.deepEqual(kinds("ALTER TABLE s.t ALTER COLUMN c TYPE bigint"), ["TABLE_REWRITE"]);
  assert.deepEqual(kinds("ALTER TABLE s.t ADD CONSTRAINT k CHECK (c > 0)"), ["VALIDATING_CONSTRAINT"]);
  assert.deepEqual(kinds("ALTER TABLE s.t ADD CONSTRAINT k CHECK (c > 0) NOT VALID"), ["BRIEF_EXCLUSIVE_LOCK"]);
  assert.deepEqual(kinds("CREATE INDEX i ON s.t (c)"), ["WRITE_BLOCKING_INDEX"]);
  assert.deepEqual(kinds("CREATE INDEX CONCURRENTLY i ON s.t (c)"), ["OTHER"]);
  assert.deepEqual(kinds("UPDATE s.t SET c = 1"), ["BACKFILL"]);
  assert.deepEqual(kinds("CREATE TABLE s.n (id int)"), ["NEW_OBJECT"]);
  const summary = MS.summarize(MS.analyzeSql("DROP TABLE s.t; CREATE INDEX i ON s.u (c)"));
  assert.deepEqual(summary.blocking.map((b) => b.kind), ["DESTRUCTIVE"]);
  assert.deepEqual(summary.review_tables, ["s.u"]);
});

test("connection strings are redacted from operator output", () => {
  // Built at runtime so the repository holds no credential-shaped literal.
  const url = new URL("postgresql://host.invalid:5432/db");
  url.username = "migrator";
  url.password = "not-a-real-secret";
  assert.equal(MS.redactUrl("failed " + url.toString() + " now"), "failed [redacted-url] now");
  url.protocol = "postgres:";
  assert.equal(MS.redactUrl(url.toString()), "[redacted-url]");
});

test("prohibited fields are refused in datasets and event payload schemas, at any depth", () => {
  const errors = C.prohibitedFieldErrors(
    [{ dataset_id: "p.ds", allowed_fields: [{ name: "value" }, { name: "NIN" }, { name: "card_number" }] }],
    [{ family: "p.ds.event", payload_schema: { type: "object", properties: { order: { type: "object", properties: { otp: { type: "string" } } }, track: { type: "array", items: { type: "object", properties: { latitude: { type: "number" } } } } } } }],
  );
  assert.deepEqual(errors, ["PROHIBITED_FIELD:p.ds.NIN", "PROHIBITED_FIELD:p.ds.card_number", "PROHIBITED_FIELD:p.ds.event.otp", "PROHIBITED_FIELD:p.ds.event.latitude"]);
  assert.deepEqual(C.prohibitedFieldErrors([{ dataset_id: "p.ds", allowed_fields: [{ name: "metric_id" }, { name: "value" }, { name: "pending_count" }] }], []), []);
  // The protocol has exactly four privacy classes; CREDENTIAL and HEALTH are not expressible and therefore never syncable.
  assert.deepEqual([...C.PRIVACY_CLASSES], ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED_PII"]);
  assert.deepEqual([...C.HQ_SYNCABLE_PRIVACY], ["PUBLIC", "INTERNAL", "CONFIDENTIAL"]);
});
