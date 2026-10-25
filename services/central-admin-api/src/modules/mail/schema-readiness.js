"use strict";

// Is the Mail schema present? (spec §20/§22: "staging deployment without
// migration -> fail readiness gracefully").
//
// The API image can reach staging before an operator applies the manual Mail
// migrations. Until every requirement below exists, Mail must answer with an
// honest 503 MAIL_SCHEMA_NOT_READY (and workers must idle) instead of Prisma
// 500s. `true` is cached for the life of the process; `false` is re-checked at
// most every `recheckMs`, so applying the migration takes effect without a
// restart. Each milestone appends the objects its code needs.

const MAIL_SCHEMA_REQUIREMENTS = [
  {
    migration: "20261024_add_cosmicforge_mail_m1_m6.sql",
    tables: [
      "mail_organizations", "mail_domains", "mail_mailboxes", "mail_addresses", "mail_memberships", "mail_sender_grants", "mail_provision_requests",
      "mail_threads", "mail_messages", "mail_message_recipients", "mail_user_thread_states", "mail_drafts", "mail_labels", "mail_thread_labels", "mail_rules",
      "mail_attachments", "mail_internal_notes", "mail_outbox_jobs", "mail_webhook_events", "mail_delivery_events", "mail_audit_events", "mail_retention_policies",
      "mail_legal_holds", "mail_step_up_verifications", "mail_break_glass_requests", "marketing_email_contacts", "marketing_email_consents",
      "marketing_email_suppressions", "marketing_email_audiences", "marketing_email_audience_contacts", "marketing_email_segments",
      "marketing_email_studio_templates", "marketing_email_template_versions", "marketing_email_campaigns", "marketing_email_campaign_snapshots",
      "marketing_email_campaign_approvals",
    ],
  },
  { migration: "20261026_mail_step_up_session_binding.sql", columns: [["mail_step_up_verifications", "session_id"]] },
  {
    migration: "20261027_mail_m7_broadcasts_automation.sql",
    tables: [
      "marketing_brand_settings", "marketing_campaign_approved_contacts", "marketing_broadcast_dispatches", "marketing_broadcast_recipients",
      "marketing_automations", "marketing_automation_versions", "marketing_automation_enrollments", "marketing_automation_step_runs", "marketing_trigger_events",
    ],
  },
];

function quoteLiteral(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`unsafe identifier ${value}`);
  return `'${value}'`;
}

function createMailSchemaReadiness({ client, logger = null, recheckMs = 30_000, now = () => Date.now(), requirements = MAIL_SCHEMA_REQUIREMENTS } = {}) {
  let ready = false;
  let missing = null;
  let checkedAt = null;
  let inFlight = null;
  let warned = false;

  async function probe() {
    const tables = requirements.flatMap((entry) => entry.tables || []);
    const columns = requirements.flatMap((entry) => entry.columns || []);
    try {
      const [tableRows, columnRows] = await Promise.all([
        tables.length ? client.$queryRawUnsafe(`SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relname IN (${tables.map(quoteLiteral).join(", ")})`) : [],
        columns.length ? client.$queryRawUnsafe(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND (${columns.map(([table, column]) => `(table_name = ${quoteLiteral(table)} AND column_name = ${quoteLiteral(column)})`).join(" OR ")})`) : [],
      ]);
      const presentTables = new Set(tableRows.map((row) => row.relname));
      const presentColumns = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`));
      return requirements
        .filter((entry) => (entry.tables || []).some((table) => !presentTables.has(table)) || (entry.columns || []).some(([table, column]) => !presentColumns.has(`${table}.${column}`)))
        .map((entry) => entry.migration);
    } catch {
      return requirements.map((entry) => entry.migration);
    }
  }

  async function check() {
    if (ready) return { ready: true, missing: [] };
    if (checkedAt !== null && now() - checkedAt < recheckMs) return { ready: false, missing };
    inFlight ??= probe().then((result) => {
      missing = result;
      ready = result.length === 0;
      checkedAt = now();
      inFlight = null;
      if (!ready && !warned) {
        warned = true;
        logger?.warn?.(`[Mail] Mail schema not present (missing: ${result.join(", ")}). Mail answers 503 MAIL_SCHEMA_NOT_READY and workers idle until the approved migrations are applied.`);
      }
      if (ready) logger?.info?.("[Mail] Mail schema detected.");
      return { ready, missing };
    });
    return inFlight;
  }

  return Object.freeze({
    check,
    isReady: async () => (await check()).ready,
    reset() {
      ready = false;
      missing = null;
      checkedAt = null;
      inFlight = null;
      warned = false;
    },
  });
}

module.exports = { createMailSchemaReadiness, MAIL_SCHEMA_REQUIREMENTS };
