// Minimal in-memory Prisma fake covering only the delegates the Marketing
// Intelligence module touches. Mirrors the behaviors the code relies on
// (unique constraints -> P2002, conditional updateMany counts, upserts).

function p2002() {
  const error = new Error("Unique constraint failed");
  error.code = "P2002";
  return error;
}

function pick(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = row[key];
  }
  return out;
}

function matchesDate(value, condition) {
  if (condition instanceof Date) return value.getTime() === condition.getTime();
  if (condition.gte && value < condition.gte) return false;
  if (condition.gt && value <= condition.gt) return false;
  if (condition.lte && value > condition.lte) return false;
  if (condition.lt && value >= condition.lt) return false;
  return true;
}

function createFakePrisma() {
  let idCounter = 0;
  const nextId = () => `00000000-0000-4000-8000-${(idCounter += 1).toString(16).padStart(12, "0")}`;

  const locks = new Map();
  const connections = [];
  const rawInsights = [];
  const snapshots = [];
  const funnelEvents = [];
  const attributions = [];
  const oauthStates = [];
  const identityLinks = [];
  const attributionDecisions = [];
  const settings = [];
  const evaluationRuns = [];

  const snapshotKey = (row) =>
    `${row.platform}|${row.accountId || "ENV"}|${row.campaignExternalId}|${row.date.toISOString().slice(0, 10)}`;

  return {
    __state: {
      locks,
      connections,
      rawInsights,
      snapshots,
      funnelEvents,
      attributions,
      oauthStates,
      identityLinks,
      attributionDecisions,
      settings,
      evaluationRuns,
    },

    marketing_sync_locks: {
      async create({ data }) {
        if (locks.has(data.key)) throw p2002();
        locks.set(data.key, { ...data });
        return { ...data };
      },
      async updateMany({ where, data }) {
        const row = locks.get(where.key);
        if (!row) return { count: 0 };
        if (where.owner && row.owner !== where.owner) return { count: 0 };
        if (where.expiresAt?.lt && !(row.expiresAt < where.expiresAt.lt)) {
          return { count: 0 };
        }
        if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      async deleteMany({ where }) {
        const row = locks.get(where.key);
        if (!row) return { count: 0 };
        if (where.owner && row.owner !== where.owner) return { count: 0 };
        locks.delete(where.key);
        return { count: 1 };
      },
    },

    marketing_attributions: {
      async findUnique({ where }) {
        if (where.anonId) {
          return attributions.find((row) => row.anonId === where.anonId) || null;
        }
        if (where.id) {
          return attributions.find((row) => row.id === where.id) || null;
        }
        return null;
      },
      async findMany({ where, orderBy, take } = {}) {
        let rows = attributions
          .filter((row) => !where?.userId || row.userId === where.userId)
          .filter((row) => !where?.anonId || row.anonId === where.anonId);
        if (orderBy?.firstCapturedAt === "asc") {
          rows = rows.sort((a, b) => a.firstCapturedAt - b.firstCapturedAt);
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((row) => ({ ...row }));
      },
      async create({ data }) {
        if (attributions.some((row) => row.anonId === data.anonId)) throw p2002();
        const row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        attributions.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = attributions.find((candidate) => candidate.anonId === where.anonId || candidate.id === where.id);
        if (!row) {
          const error = new Error("Record not found");
          error.code = "P2025";
          throw error;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    },

    marketing_ad_platform_connections: {
      async findMany({ where } = {}) {
        return connections
          .filter((row) => !where?.platform || row.platform === where.platform)
          .filter((row) => !where?.status || row.status === where.status)
          .map((row) => ({ ...row }));
      },
      async findUnique({ where }) {
        let row = null;
        if (where.id) {
          row = connections.find((candidate) => candidate.id === where.id) || null;
        } else if (where.platform_accountId) {
          const key = where.platform_accountId;
          row = connections.find(
            (candidate) => candidate.platform === key.platform && candidate.accountId === key.accountId,
          ) || null;
        }
        return row ? { ...row } : null;
      },
      async create({ data }) {
        if (
          connections.some(
            (row) => row.platform === data.platform && row.accountId === data.accountId,
          )
        ) {
          throw p2002();
        }
        const row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        connections.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = connections.find((candidate) => candidate.id === where.id);
        if (!row) {
          const error = new Error("Record not found");
          error.code = "P2025";
          throw error;
        }
        Object.assign(row, data);
        return { ...row };
      },
    },

    marketing_oauth_states: {
      async create({ data }) {
        if (oauthStates.some((row) => row.stateHash === data.stateHash)) throw p2002();
        const row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        oauthStates.push(row);
        return { ...row };
      },
      async findUnique({ where }) {
        let row = null;
        if (where.id) row = oauthStates.find((candidate) => candidate.id === where.id) || null;
        if (where.stateHash) {
          row = oauthStates.find((candidate) => candidate.stateHash === where.stateHash) || null;
        }
        return row ? { ...row } : null;
      },
      async update({ where, data }) {
        const row = oauthStates.find((candidate) => candidate.id === where.id);
        if (!row) {
          const error = new Error("Record not found");
          error.code = "P2025";
          throw error;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    },

    marketing_ad_insights_raw: {
      async upsert({ where, create, update }) {
        const key = where.platform_accountId_campaignExternalId_date || where.platform_campaignExternalId_date;
        const existing = rawInsights.find(
          (row) =>
            row.platform === key.platform &&
            (row.accountId || "ENV") === (key.accountId || "ENV") &&
            row.campaignExternalId === key.campaignExternalId &&
            row.date.getTime() === key.date.getTime(),
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { id: nextId(), ...create };
        rawInsights.push(row);
        return { ...row };
      },
    },

    marketing_performance_snapshots: {
      async findUnique({ where, select }) {
        let row = null;
        if (where.id) {
          row = snapshots.find((candidate) => candidate.id === where.id) || null;
        } else if (where.platform_accountId_campaignExternalId_date || where.platform_campaignExternalId_date) {
          const key = where.platform_accountId_campaignExternalId_date || where.platform_campaignExternalId_date;
          row =
            snapshots.find(
              (candidate) => snapshotKey(candidate) === snapshotKey(key),
            ) || null;
        }
        return row ? pick(row, select) : null;
      },
      async findMany({ where, select } = {}) {
        let rows = snapshots
          .filter((row) => !where?.platform || row.platform === where.platform)
          .filter((row) => !where?.accountId || row.accountId === where.accountId)
          .filter((row) => !where?.connectionId || row.connectionId === where.connectionId)
          .filter(
            (row) =>
              !where?.campaignExternalId ||
              row.campaignExternalId === where.campaignExternalId,
          )
          .filter((row) => !where?.date || matchesDate(row.date, where.date));
        if (arguments[0]?.take) rows = rows.slice(0, arguments[0].take);
        return rows.map((row) => pick(row, select));
      },
      async findFirst({ where, select } = {}) {
        const rows = await this.findMany({ where, select });
        return rows[0] || null;
      },
      async create({ data }) {
        const row = { id: nextId(), ...data };
        if (snapshots.some((candidate) => snapshotKey(candidate) === snapshotKey(row))) {
          throw p2002();
        }
        snapshots.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        let row = null;
        if (where.id) {
          row = snapshots.find((candidate) => candidate.id === where.id);
        } else if (where.platform_accountId_campaignExternalId_date || where.platform_campaignExternalId_date) {
          const key = where.platform_accountId_campaignExternalId_date || where.platform_campaignExternalId_date;
          row = snapshots.find(
            (candidate) => snapshotKey(candidate) === snapshotKey(key),
          );
        }
        if (!row) {
          const error = new Error("Record not found");
          error.code = "P2025";
          throw error;
        }
        Object.assign(row, data);
        return { ...row };
      },
      async count() {
        return snapshots.length;
      },
    },

    marketing_funnel_events: {
      async findMany({ where, select } = {}) {
        let rows = funnelEvents
          .filter((row) => {
            if (!where?.stage) return true;
            if (where.stage.in) return where.stage.in.includes(row.stage);
            return row.stage === where.stage;
          })
          .filter(
            (row) =>
              !where?.campaignExternalId ||
              row.campaignExternalId === where.campaignExternalId,
          )
          .filter((row) => !where?.connectionId || row.connectionId === where.connectionId)
          .filter((row) => !where?.accountExternalId || row.accountExternalId === where.accountExternalId)
          .filter((row) => !where?.occurredAt || matchesDate(row.occurredAt, where.occurredAt))
          .filter((row) => {
            if (!where?.OR) return true;
            return where.OR.some((clause) => {
              if (clause.userId && row.userId === clause.userId) return true;
              if (clause.anonId?.in && clause.anonId.in.includes(row.anonId)) return true;
              if (clause.anonId && row.anonId === clause.anonId) return true;
              return false;
            });
          });
        if (arguments[0]?.take) rows = rows.slice(0, arguments[0].take);
        return rows.map((row) => pick(row, select));
      },
      async findUnique({ where, select }) {
        const row =
          funnelEvents.find(
            (candidate) =>
              where.externalEventId &&
              candidate.externalEventId === where.externalEventId,
          ) ||
          funnelEvents.find((candidate) => where.id && candidate.id === where.id) ||
          null;
        return row ? pick(row, select) : null;
      },
      async create({ data }) {
        if (
          data.externalEventId &&
          funnelEvents.some((row) => row.externalEventId === data.externalEventId)
        ) {
          throw p2002();
        }
        const normalizedData = {
          ...data,
          ...(data.value && typeof data.value.toFixed === "function"
            ? { value: Number(data.value.toFixed(2)) }
            : {}),
        };
        const row = { id: nextId(), ...normalizedData };
        funnelEvents.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = funnelEvents.find(
          (candidate) =>
            (where.id && candidate.id === where.id) ||
            (where.externalEventId && candidate.externalEventId === where.externalEventId),
        );
        if (!row) {
          const error = new Error("Record not found");
          error.code = "P2025";
          throw error;
        }
        Object.assign(row, data);
        return { ...row };
      },
    },

    marketing_identity_links: {
      async findUnique({ where }) {
        const row =
          identityLinks.find((candidate) => where.id && candidate.id === where.id) ||
          identityLinks.find((candidate) => where.anonIdHash && candidate.anonIdHash === where.anonIdHash) ||
          null;
        return row ? { ...row } : null;
      },
      async create({ data }) {
        if (identityLinks.some((row) => row.anonIdHash === data.anonIdHash)) throw p2002();
        const row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        identityLinks.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = identityLinks.find((candidate) => candidate.id === where.id || candidate.anonIdHash === where.anonIdHash);
        if (!row) {
          const error = new Error("Record not found");
          error.code = "P2025";
          throw error;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    },

    marketing_attribution_decisions: {
      async findMany({ where, select } = {}) {
        return attributionDecisions
          .filter((row) => {
            if (!where?.conversionEventId) return true;
            if (where.conversionEventId.in) {
              return where.conversionEventId.in.includes(row.conversionEventId);
            }
            return row.conversionEventId === where.conversionEventId;
          })
          .filter((row) => !where?.status || row.status === where.status)
          .map((row) => pick(row, select));
      },
      async findUnique({ where }) {
        const row =
          attributionDecisions.find((candidate) => where.id && candidate.id === where.id) ||
          attributionDecisions.find(
            (candidate) =>
              where.conversionEventId &&
              candidate.conversionEventId === where.conversionEventId,
          ) ||
          null;
        return row ? { ...row } : null;
      },
      async create({ data }) {
        if (attributionDecisions.some((row) => row.conversionEventId === data.conversionEventId)) throw p2002();
        const row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        attributionDecisions.push(row);
        return { ...row };
      },
      async upsert({ where, create, update }) {
        const row = attributionDecisions.find(
          (candidate) => candidate.conversionEventId === where.conversionEventId,
        );
        if (row) {
          Object.assign(row, update, { updatedAt: new Date() });
          return { ...row };
        }
        const created = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...create };
        attributionDecisions.push(created);
        return { ...created };
      },
    },

    marketing_intelligence_settings: {
      async findUnique({ where }) {
        const row = settings.find((candidate) => candidate.key === where.key) || null;
        return row ? { ...row } : null;
      },
      async upsert({ where, create, update }) {
        const row = settings.find((candidate) => candidate.key === where.key);
        if (row) {
          Object.assign(row, update, { updatedAt: new Date() });
          return { ...row };
        }
        const created = { createdAt: new Date(), updatedAt: new Date(), ...create };
        settings.push(created);
        return { ...created };
      },
    },

    marketing_intelligence_evaluation_runs: {
      async create({ data }) {
        const row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        evaluationRuns.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = evaluationRuns.find((candidate) => candidate.id === where.id);
        if (!row) {
          const error = new Error("Record not found");
          error.code = "P2025";
          throw error;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    },
  };
}

module.exports = { createFakePrisma };
