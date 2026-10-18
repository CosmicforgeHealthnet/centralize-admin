const { mainPrisma } = require("../../shared/config/mainDatabase");

class AnalyticsService {
  // ─── TRACK EVENT (public) ────────────────────────────────────────────────

  async trackEvent(payload) {
    const {
      session_id,
      is_new_session = false,
      is_returning_visitor = false,
      timestamp,
      event_type,
      page,
      referrer,
      user_type_intent = "unknown",
      event_data,
      utm,
      device,
      geo,
    } = payload;

    // 1. Insert the event
    const event = await mainPrisma.analytics_events.create({
      data: {
        session_id,
        is_new_session,
        is_returning_visitor,
        event_type,
        page: page ?? null,
        referrer: referrer ?? null,
        user_type_intent,
        event_data: event_data ?? null,
        utm_source: utm?.source ?? null,
        utm_medium: utm?.medium ?? null,
        utm_campaign: utm?.campaign ?? null,
        utm_term: utm?.term ?? null,
        utm_content: utm?.content ?? null,
        device_type: device?.type ?? null,
        device_browser: device?.browser ?? null,
        device_os: device?.os ?? null,
        device_screen_width: device?.screen_width ?? null,
        geo_country: geo?.country ?? null,
        geo_city: geo?.city ?? null,
        geo_ip_hash: geo?.ip_hash ?? null,
        ...(timestamp ? { created_at: new Date(timestamp) } : {}),
      },
    });

    // 2. Upsert the session
    await mainPrisma.analytics_sessions.upsert({
      where: { session_id },
      create: {
        session_id,
        first_seen: timestamp ? new Date(timestamp) : new Date(),
        last_seen: timestamp ? new Date(timestamp) : new Date(),
        is_returning_visitor,
        user_type_intent,
        geo_country: geo?.country ?? null,
        geo_city: geo?.city ?? null,
        device_type: device?.type ?? null,
        referrer: referrer ?? null,
        utm_source: utm?.source ?? null,
        utm_medium: utm?.medium ?? null,
        utm_campaign: utm?.campaign ?? null,
        pages_visited: page ? [page] : [],
        events_count: 1,
        converted: event_type === "waitlist_signup",
        conversion_event: event_type === "waitlist_signup" ? event_type : null,
      },
      update: {
        last_seen: timestamp ? new Date(timestamp) : new Date(),
        user_type_intent,
        events_count: { increment: 1 },
        ...(event_type === "waitlist_signup"
          ? { converted: true, conversion_event: event_type }
          : {}),
      },
    });

    // 3. Append page to pages_visited array (deduplicated)
    if (page) {
      await mainPrisma.$executeRaw`
        UPDATE analytics_sessions
        SET pages_visited = (
          SELECT jsonb_agg(DISTINCT val)
          FROM jsonb_array_elements_text(pages_visited::jsonb || ${JSON.stringify([page])}::jsonb) AS val
        )
        WHERE session_id = ${session_id}
      `;
    }

    return event;
  }

  // ─── LIST RAW EVENTS (admin) ─────────────────────────────────────────────

  async listEvents({ session_id, event_type, page = 1, limit = 50 }) {
    const skip = (page - 1) * limit;
    const where = {
      ...(session_id ? { session_id } : {}),
      ...(event_type ? { event_type } : {}),
    };

    const [events, total] = await Promise.all([
      mainPrisma.analytics_events.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip,
        take: limit,
      }),
      mainPrisma.analytics_events.count({ where }),
    ]);

    return { events, total, page, limit };
  }

  // ─── DASHBOARD STATS (admin) ─────────────────────────────────────────────

  async getStats({ from, to } = {}) {
    const dateFilter =
      from || to
        ? {
            created_at: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {};

    const sessionDateFilter =
      from || to
        ? {
            first_seen: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {};

    const [
      totalEvents,
      totalSessions,
      returningVisitors,
      allSessions,
      topPages,
      byCountry,
      byDevice,
      planInterest,
      conversions,
    ] = await Promise.all([
      mainPrisma.analytics_events.count({ where: dateFilter }),
      mainPrisma.analytics_sessions.count({ where: sessionDateFilter }),
      mainPrisma.analytics_sessions.count({
        where: { ...sessionDateFilter, is_returning_visitor: true },
      }),
      mainPrisma.analytics_sessions.findMany({
        where: sessionDateFilter,
        select: {
          user_type_intent: true,
          referrer: true,
          utm_source: true,
          utm_medium: true,
          utm_campaign: true,
          geo_country: true,
          device_type: true,
          converted: true,
          conversion_event: true,
        },
      }),
      mainPrisma.analytics_events.groupBy({
        by: ["page"],
        where: { ...dateFilter, page: { not: null } },
        _count: { page: true },
        orderBy: { _count: { page: "desc" } },
        take: 10,
      }),
      mainPrisma.analytics_sessions.groupBy({
        by: ["geo_country"],
        where: { ...sessionDateFilter, geo_country: { not: null } },
        _count: { geo_country: true },
        orderBy: { _count: { geo_country: "desc" } },
        take: 10,
      }),
      mainPrisma.analytics_sessions.groupBy({
        by: ["device_type"],
        where: { ...sessionDateFilter, device_type: { not: null } },
        _count: { device_type: true },
      }),
      mainPrisma.analytics_sessions.groupBy({
        by: ["user_type_intent"],
        where: sessionDateFilter,
        _count: { user_type_intent: true },
        orderBy: { _count: { user_type_intent: "desc" } },
      }),
      mainPrisma.analytics_sessions.count({
        where: { ...sessionDateFilter, converted: true },
      }),
    ]);

    // build traffic sources from referrer / utm_source
    const trafficMap = {};
    for (const s of allSessions) {
      const source = s.utm_source || s.referrer || "direct";
      trafficMap[source] = (trafficMap[source] || 0) + 1;
    }
    const topTrafficSources = Object.entries(trafficMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([source, count]) => ({ source, count }));

    // by_user_type breakdown
    const byUserType = {};
    for (const s of allSessions) {
      byUserType[s.user_type_intent] =
        (byUserType[s.user_type_intent] || 0) + 1;
    }

    return {
      total_visitors: totalEvents,
      unique_sessions: totalSessions,
      returning_visitors: returningVisitors,
      by_user_type: byUserType,
      top_pages: topPages.map((p) => ({ page: p.page, count: p._count.page })),
      top_traffic_sources: topTrafficSources,
      by_country: byCountry.map((c) => ({
        country: c.geo_country,
        count: c._count.geo_country,
      })),
      by_device: byDevice.reduce((acc, d) => {
        acc[d.device_type] = d._count.device_type;
        return acc;
      }, {}),
      plan_interest: planInterest.map((p) => ({
        type: p.user_type_intent,
        count: p._count.user_type_intent,
      })),
      conversions: {
        total: conversions,
        rate:
          totalSessions > 0
            ? ((conversions / totalSessions) * 100).toFixed(2) + "%"
            : "0%",
      },
    };
  }

  // ─── VISITOR SESSIONS (admin) ────────────────────────────────────────────

  async getVisitors({
    page = 1,
    limit = 50,
    country,
    user_type_intent,
    converted,
  }) {
    const skip = (page - 1) * limit;
    const where = {
      ...(country ? { geo_country: country } : {}),
      ...(user_type_intent ? { user_type_intent } : {}),
      ...(converted !== undefined
        ? { converted: converted === "true" || converted === true }
        : {}),
    };

    const [sessions, total] = await Promise.all([
      mainPrisma.analytics_sessions.findMany({
        where,
        orderBy: { first_seen: "desc" },
        skip,
        take: limit,
      }),
      mainPrisma.analytics_sessions.count({ where }),
    ]);

    return { sessions, total, page, limit };
  }

  // ─── WAITLIST (admin) ────────────────────────────────────────────────────

  async getWaitlist({ page = 1, limit = 50, role, country }) {
    const skip = (page - 1) * limit;
    const where = {
      ...(role ? { role } : {}),
      ...(country ? { country } : {}),
    };

    const [entries, total] = await Promise.all([
      mainPrisma.analytics_waitlist.findMany({
        where,
        orderBy: { signed_up_at: "desc" },
        skip,
        take: limit,
      }),
      mainPrisma.analytics_waitlist.count({ where }),
    ]);

    return { entries, total, page, limit };
  }
}

module.exports = new AnalyticsService();
