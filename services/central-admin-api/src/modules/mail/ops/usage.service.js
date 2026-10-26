"use strict";

// Usage counters and quota limits, split by purpose and brand.
// Counts only. No provider prices are stored or assumed: a cost estimate is
// shown only when an operator configures MAIL_COST_RATES from their own
// contract (JSON: {"currency":"USD","perThousand":{"STAFF_MAIL":0.0,...}}).
// Days are UTC calendar days.

const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");

const PURPOSES = Object.freeze(["STAFF_MAIL", "SUPPORT", "MARKETING_BROADCAST", "MARKETING_AUTOMATION", "MARKETING_CONFIRMATION", "INBOUND"]);
const LIMITABLE = Object.freeze(PURPOSES.filter((purpose) => purpose !== "INBOUND"));
// Purposes whose queued mail lives in mail_message_recipients (staff/support).
const QUEUE_TRACKED = Object.freeze(["STAFF_MAIL", "SUPPORT"]);

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function monthStart(date) {
  return `${date.toISOString().slice(0, 7)}-01`;
}

function parseCostRates(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed.currency !== "string" || typeof parsed.perThousand !== "object") return null;
    const perThousand = {};
    for (const [purpose, rate] of Object.entries(parsed.perThousand)) if (PURPOSES.includes(purpose) && Number.isFinite(Number(rate)) && Number(rate) >= 0) perThousand[purpose] = Number(rate);
    return { currency: parsed.currency.slice(0, 8), perThousand };
  } catch {
    return null;
  }
}

function createUsageService({ client, audit, env = process.env, clock = () => new Date(), notify = null }) {
  const costRates = parseCostRates(env.MAIL_COST_RATES);

  async function record(db, { organizationId, purpose, accepted = 0, rejected = 0, received = 0, providerRequests = 0, bytes = 0 }) {
    if (!organizationId || !PURPOSES.includes(purpose)) return;
    const values = [accepted, rejected, received, providerRequests].map((value) => Math.max(0, Math.trunc(Number(value) || 0)));
    const byteCount = BigInt(Math.max(0, Math.trunc(Number(bytes) || 0)));
    if (!values.some(Boolean) && !byteCount) return;
    await (db || client).$executeRaw`
      INSERT INTO "mail_usage_daily" ("organization_id", "purpose", "day", "accepted", "rejected", "received", "provider_requests", "bytes", "updated_at")
      VALUES (${organizationId}::uuid, ${purpose}, ${utcDay(clock())}::date, ${values[0]}, ${values[1]}, ${values[2]}, ${values[3]}, ${byteCount}, now())
      ON CONFLICT ("organization_id", "purpose", "day") DO UPDATE SET
        "accepted" = "mail_usage_daily"."accepted" + EXCLUDED."accepted",
        "rejected" = "mail_usage_daily"."rejected" + EXCLUDED."rejected",
        "received" = "mail_usage_daily"."received" + EXCLUDED."received",
        "provider_requests" = "mail_usage_daily"."provider_requests" + EXCLUDED."provider_requests",
        "bytes" = "mail_usage_daily"."bytes" + EXCLUDED."bytes",
        "updated_at" = now()`;
  }

  async function totals(organizationId, purpose, db = client) {
    const now = clock();
    const rows = await db.mailUsageDaily.findMany({ where: { organizationId, purpose, day: { gte: new Date(`${monthStart(now)}T00:00:00Z`) } } });
    const today = utcDay(now);
    return {
      today: rows.filter((row) => utcDay(row.day) === today).reduce((sum, row) => sum + row.accepted, 0),
      month: rows.reduce((sum, row) => sum + row.accepted, 0),
    };
  }

  // External recipients queued but not yet accepted by the provider. They
  // are counted toward the limit so a burst of queued mail cannot overshoot.
  async function queuedRecipients(db, organizationId, purpose) {
    if (!QUEUE_TRACKED.includes(purpose)) return 0;
    const mailbox = purpose === "SUPPORT" ? { organizationId, purpose: "SUPPORT" } : { organizationId, NOT: { purpose: "SUPPORT" } };
    return db.mailMessageRecipient.count({ where: { status: "PENDING", message: { direction: "OUTBOUND", mailbox } } });
  }

  /**
   * Returns { allowed, reason, limit, period, soft } for sending `count` more
   * messages. Never throws; callers decide whether to refuse or defer.
   * includeQueued (default true) also counts queued, not yet accepted staff
   * recipients; the dispatcher passes false because the batch it is about to
   * send is itself queued. `db` lets callers check inside their transaction.
   */
  async function check(organizationId, purpose, count = 1, { includeQueued = true, db = client } = {}) {
    if (!organizationId) return { allowed: true, soft: false };
    const limit = await db.mailQuotaLimit.findUnique({ where: { organizationId_purpose: { organizationId, purpose } } });
    if (!limit) return { allowed: true, soft: false };
    const used = await totals(organizationId, purpose, db);
    if (includeQueued) {
      const queued = await queuedRecipients(db, organizationId, purpose);
      used.today += queued;
      used.month += queued;
    }
    if (limit.dailyHardLimit != null && used.today + count > limit.dailyHardLimit) return { allowed: false, reason: "MAIL_QUOTA_HARD_LIMIT", limit: limit.dailyHardLimit, period: "day", used: used.today };
    if (limit.monthlyHardLimit != null && used.month + count > limit.monthlyHardLimit) return { allowed: false, reason: "MAIL_QUOTA_HARD_LIMIT", limit: limit.monthlyHardLimit, period: "month", used: used.month };
    const soft = limit.dailySoftLimit != null && used.today + count > limit.dailySoftLimit;
    if (soft && notify) await notify({ organizationId, purpose, limit: limit.dailySoftLimit, used: used.today }).catch(() => {});
    return { allowed: true, soft };
  }

  async function assertWithinQuota(organizationId, purpose, count = 1, options = {}) {
    const result = await check(organizationId, purpose, count, options);
    if (!result.allowed) throw mailError("MAIL_QUOTA_HARD_LIMIT", { purpose, period: result.period, limit: result.limit });
    return result;
  }

  // ---- administration (mail admins) -------------------------------------
  async function report(user, { organizationId, days } = {}) {
    await policy.requireMailAdmin(client, user, "VIEW");
    const span = Math.min(Math.max(Number(days) || 30, 1), 366);
    const since = new Date(`${utcDay(new Date(clock().getTime() - (span - 1) * 86400000))}T00:00:00Z`);
    const where = { day: { gte: since }, ...(policy.isUuid(organizationId) ? { organizationId } : {}) };
    const [rows, limits, organizations] = await Promise.all([
      client.mailUsageDaily.findMany({ where, orderBy: [{ day: "asc" }] }),
      client.mailQuotaLimit.findMany({ where: policy.isUuid(organizationId) ? { organizationId } : {} }),
      client.mailOrganization.findMany({ select: { id: true, slug: true, name: true } }),
    ]);
    const byKey = new Map();
    for (const row of rows) {
      const key = `${row.organizationId}:${row.purpose}`;
      const entry = byKey.get(key) || { organizationId: row.organizationId, purpose: row.purpose, accepted: 0, rejected: 0, received: 0, providerRequests: 0, bytes: 0, daily: [] };
      entry.accepted += row.accepted;
      entry.rejected += row.rejected;
      entry.received += row.received;
      entry.providerRequests += row.providerRequests;
      entry.bytes += Number(row.bytes);
      entry.daily.push({ day: utcDay(row.day), accepted: row.accepted, received: row.received });
      byKey.set(key, entry);
    }
    const orgs = new Map(organizations.map((org) => [org.id, org]));
    const summary = [...byKey.values()].map((entry) => {
      const rate = costRates?.perThousand?.[entry.purpose];
      return { ...entry, organization: orgs.get(entry.organizationId) || { id: entry.organizationId }, estimatedCost: rate == null ? null : Math.round((entry.accepted / 1000) * rate * 100) / 100 };
    });
    return {
      days: span,
      since: since.toISOString(),
      summary,
      limits: limits.map((limit) => ({ ...limit, updatedAt: limit.updatedAt.toISOString() })),
      cost: costRates ? { currency: costRates.currency, source: "MAIL_COST_RATES (operator-provided)" } : { currency: null, source: null, note: "No prices configured. Counts only; multiply by your contracted provider rates." },
    };
  }

  async function setLimit(user, { organizationId, purpose, dailySoftLimit = null, dailyHardLimit = null, monthlyHardLimit = null }, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    if (!policy.isUuid(organizationId) || !(await client.mailOrganization.findUnique({ where: { id: organizationId } }))) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    if (!LIMITABLE.includes(purpose)) throw mailError("MAIL_VALIDATION_FAILED", { field: "purpose" });
    const clean = (value, field) => {
      if (value === null || value === undefined || value === "") return null;
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > 100000000) throw mailError("MAIL_VALIDATION_FAILED", { field });
      return number;
    };
    const data = { dailySoftLimit: clean(dailySoftLimit, "dailySoftLimit"), dailyHardLimit: clean(dailyHardLimit, "dailyHardLimit"), monthlyHardLimit: clean(monthlyHardLimit, "monthlyHardLimit") };
    if (data.dailySoftLimit && data.dailyHardLimit && data.dailySoftLimit > data.dailyHardLimit) throw mailError("MAIL_VALIDATION_FAILED", { field: "dailySoftLimit", reason: "SOFT_ABOVE_HARD" });
    const row = await client.mailQuotaLimit.upsert({ where: { organizationId_purpose: { organizationId, purpose } }, create: { organizationId, purpose, ...data, updatedBy: user.id }, update: { ...data, updatedBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_QUOTA_LIMIT_SET", targetType: "mail_quota_limit", targetId: row.id, organizationId, metadata: { purpose, ...data } }, context);
    return { ...row, updatedAt: row.updatedAt.toISOString() };
  }

  return { record, totals, check, assertWithinQuota, report, setLimit, PURPOSES, LIMITABLE, costConfigured: Boolean(costRates) };
}

module.exports = { createUsageService, PURPOSES, LIMITABLE, parseCostRates, utcDay };
