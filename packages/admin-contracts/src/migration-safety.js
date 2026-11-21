"use strict";

// Migration discipline shared by every Product Admin database and the HQ
// integration schema (Section 9.5). Dependency-free: callers pass a client
// with `query(sql, params)`.
//
//  - splitStatements(): splits SQL into statements, respecting comments,
//    quoted strings and dollar-quoted function bodies;
//  - analyzeSql(): classifies each statement's locking / data risk so a
//    preview can show what a pending migration will do before it runs;
//  - roleAttributes() / runtimeRoleProblems(): a runtime role must not be a
//    superuser, create roles or databases, bypass row security, own the
//    schema or be the migration identity itself.

function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      buf += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      buf += " ";
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j += 1;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// First matching rule wins; ordered from most to least disruptive.
const RULES = [
  ["DESTRUCTIVE", /^\s*DROP\s+(TABLE|SCHEMA|DATABASE)\b|\bDROP\s+COLUMN\b/i, "Drops data: forbidden in forward-only product-admin migrations"],
  ["DATA_REMOVAL", /^\s*(TRUNCATE|DELETE\s+FROM)\b/i, "Removes rows"],
  ["EXTENSION_REQUIRED", /^\s*CREATE\s+EXTENSION\b/i, "Requires a database extension (operator must install it)"],
  ["TABLE_REWRITE", /^\s*ALTER\s+TABLE\b[\s\S]*(\bGENERATED\s+ALWAYS\b[\s\S]*\bSTORED\b|\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b|\bSET\s+(LOGGED|UNLOGGED)\b)/i, "Rewrites the whole table under ACCESS EXCLUSIVE"],
  ["VALIDATING_CONSTRAINT", /^\s*ALTER\s+TABLE\b[\s\S]*\bADD\s+(CONSTRAINT\s+\S+\s+)?(CHECK|FOREIGN\s+KEY|UNIQUE|PRIMARY\s+KEY)\b(?![\s\S]*\bNOT\s+VALID\b)/i, "Scans existing rows to validate under a table lock"],
  ["WRITE_BLOCKING_INDEX", /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY)/i, "Builds an index while blocking writes to the table"],
  ["BRIEF_EXCLUSIVE_LOCK", /^\s*ALTER\s+TABLE\b|^\s*CREATE\s+TRIGGER\b|^\s*DROP\s+TRIGGER\b/i, "Takes a brief ACCESS EXCLUSIVE / SHARE ROW EXCLUSIVE lock (metadata only)"],
  ["BACKFILL", /^\s*UPDATE\b/i, "Backfills existing rows"],
  ["SEED_DATA", /^\s*INSERT\s+INTO\b/i, "Inserts reference rows"],
  ["NEW_OBJECT", /^\s*CREATE\s+(TABLE|SCHEMA|(OR\s+REPLACE\s+)?FUNCTION|SEQUENCE|VIEW)\b/i, "Creates a new object (no lock on existing data)"],
];

function targetOf(statement) {
  const m = /^\s*(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON|CREATE\s+TRIGGER\s+\S+\s+[\s\S]*?\bON|UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|CREATE\s+TABLE|DROP\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)/i.exec(statement);
  return m ? m[1] : null;
}

function analyzeSql(sql) {
  return splitStatements(sql).map((statement) => {
    const rule = RULES.find(([, re]) => re.test(statement));
    return {
      kind: rule ? rule[0] : "OTHER",
      target: targetOf(statement),
      note: rule ? rule[2] : "No data or lock impact recognised",
      excerpt: statement.replace(/\s+/g, " ").slice(0, 120),
    };
  });
}

// Summary used by previews: blocking kinds stop an unattended run.
const BLOCKING_KINDS = Object.freeze(["DESTRUCTIVE", "DATA_REMOVAL", "EXTENSION_REQUIRED"]);
const REVIEW_KINDS = Object.freeze(["TABLE_REWRITE", "VALIDATING_CONSTRAINT", "WRITE_BLOCKING_INDEX", "BACKFILL"]);

function summarize(analysis) {
  const counts = {};
  for (const a of analysis) counts[a.kind] = (counts[a.kind] || 0) + 1;
  const tables = (kinds) => [...new Set(analysis.filter((a) => kinds.includes(a.kind) && a.target).map((a) => a.target))].sort();
  return {
    counts,
    blocking: analysis.filter((a) => BLOCKING_KINDS.includes(a.kind)).map((a) => ({ kind: a.kind, target: a.target, excerpt: a.excerpt })),
    review_tables: tables(REVIEW_KINDS),
    locked_tables: tables(["TABLE_REWRITE", "VALIDATING_CONSTRAINT", "WRITE_BLOCKING_INDEX", "BRIEF_EXCLUSIVE_LOCK", "BACKFILL"]),
  };
}

async function roleAttributes(client, role) {
  const { rows: [r] } = await client.query(
    `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1`, [role]);
  return r || null;
}

/** Problems that make a role unacceptable as a runtime identity. */
async function runtimeRoleProblems(client, role, { schema }) {
  const attrs = await roleAttributes(client, role);
  if (!attrs) return ["RUNTIME_ROLE_NOT_FOUND"];
  const problems = [];
  if (attrs.rolsuper) problems.push("RUNTIME_ROLE_IS_SUPERUSER");
  if (attrs.rolcreaterole) problems.push("RUNTIME_ROLE_CAN_CREATE_ROLES");
  if (attrs.rolcreatedb) problems.push("RUNTIME_ROLE_CAN_CREATE_DATABASES");
  if (attrs.rolbypassrls) problems.push("RUNTIME_ROLE_BYPASSES_RLS");
  if (attrs.rolreplication) problems.push("RUNTIME_ROLE_HAS_REPLICATION");
  const { rows: [me] } = await client.query("SELECT current_user AS u");
  if (me.u === role) problems.push("RUNTIME_ROLE_IS_MIGRATION_ROLE");
  const { rows: owned } = await client.query(
    `SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1 AND r.rolname = $2
     UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = $1 AND r.rolname = $2 LIMIT 1`, [schema, role]);
  if (owned.length) problems.push("RUNTIME_ROLE_OWNS_SCHEMA_OBJECTS");
  const { rows: member } = await client.query(
    `SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1 AND (g.rolsuper OR g.rolname = current_user) LIMIT 1`, [role]);
  if (member.length) problems.push("RUNTIME_ROLE_INHERITS_PRIVILEGED_ROLE");
  return problems;
}

/** Table privileges a role currently holds in one schema: { table: [PRIV...] }. */
async function tablePrivileges(client, role, schema) {
  const { rows } = await client.query(
    `SELECT c.relname AS t, a.privilege_type AS p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
     WHERE n.nspname = $1 AND r.rolname = $2 AND c.relkind IN ('r','p') ORDER BY 1, 2`, [schema, role]);
  const out = {};
  for (const r of rows) (out[r.t] = out[r.t] || []).push(r.p);
  return out;
}

function redactUrl(text) {
  return String(text).replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-url]");
}

module.exports = { splitStatements, analyzeSql, summarize, roleAttributes, runtimeRoleProblems, tablePrivileges, redactUrl, BLOCKING_KINDS, REVIEW_KINDS };
