const { mainPrisma } = require("../../shared/config/mainDatabase");
const { prisma } = require("../../shared/config/database");

class SupportService {
  // ── Helpers ───────────────────────────────────────────

  _getStartOfDay(daysAgo = 0) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  _getEndOfDay(daysAgo = 0) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  _calcChange(current, previous) {
    if (!previous || previous === 0) return { change: "0.0", positive: true };
    const diff = ((current - previous) / previous) * 100;
    return { change: Math.abs(diff).toFixed(1), positive: diff >= 0 };
  }

  // ── Stats ─────────────────────────────────────────────
  // Powers: HelpStatCards + SupportRequestsChart + TicketTypeChart

  async getStats() {
    const now = new Date();

    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - 7);

    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const resolvedStatuses = ["resolved", "closed"];

    const [
      // ── All-time totals (for byType display) ──────────
      accountTotal,
      disputeTotal,
      insuranceTotal,
      reportTotal,

      // ── This week new tickets (for change numerator) ──
      accountThisWeek,
      disputeThisWeek,
      insuranceThisWeek,
      reportThisWeek,

      // ── Last week new tickets (for change denominator) ─
      accountLastWeek,
      disputeLastWeek,
      insuranceLastWeek,
      reportLastWeek,

      // ── This week resolved ────────────────────────────
      accountResolvedThisWeek,
      disputeResolvedThisWeek,
      insuranceResolvedThisWeek,
      reportResolvedThisWeek,

      // ── Last week resolved ────────────────────────────
      accountResolvedLastWeek,
      disputeResolvedLastWeek,
      insuranceResolvedLastWeek,
      reportResolvedLastWeek,

      // ── This month (for byType display) ───────────────
      accountMonth,
      disputeMonth,
      insuranceMonth,
      reportMonth,

      // ── Live chat ─────────────────────────────────────
      liveChatThisWeek,
      liveChatLastWeek,
    ] = await Promise.all([
      // All-time totals
      mainPrisma.account_support.count(),
      mainPrisma.support_disputes.count(),
      mainPrisma.support_insurance.count(),
      mainPrisma.support_report.count(),

      // This week new
      mainPrisma.account_support.count({
        where: { createdAt: { gte: startOfThisWeek } },
      }),
      mainPrisma.support_disputes.count({
        where: { createdAt: { gte: startOfThisWeek } },
      }),
      mainPrisma.support_insurance.count({
        where: { createdAt: { gte: startOfThisWeek } },
      }),
      mainPrisma.support_report.count({
        where: { createdAt: { gte: startOfThisWeek } },
      }),

      // Last week new
      mainPrisma.account_support.count({
        where: { createdAt: { gte: startOfLastWeek, lt: startOfThisWeek } },
      }),
      mainPrisma.support_disputes.count({
        where: { createdAt: { gte: startOfLastWeek, lt: startOfThisWeek } },
      }),
      mainPrisma.support_insurance.count({
        where: { createdAt: { gte: startOfLastWeek, lt: startOfThisWeek } },
      }),
      mainPrisma.support_report.count({
        where: { createdAt: { gte: startOfLastWeek, lt: startOfThisWeek } },
      }),

      // This week resolved
      mainPrisma.account_support.count({
        where: {
          status: { in: resolvedStatuses },
          updatedAt: { gte: startOfThisWeek },
        },
      }),
      mainPrisma.support_disputes.count({
        where: {
          status: { in: resolvedStatuses },
          updatedAt: { gte: startOfThisWeek },
        },
      }),
      mainPrisma.support_insurance.count({
        where: {
          status: { in: resolvedStatuses },
          updatedAt: { gte: startOfThisWeek },
        },
      }),
      mainPrisma.support_report.count({
        where: {
          status: { in: resolvedStatuses },
          updatedAt: { gte: startOfThisWeek },
        },
      }),

      // Last week resolved
      mainPrisma.account_support.count({
        where: {
          status: { in: resolvedStatuses },
          updatedAt: { gte: startOfLastWeek, lt: startOfThisWeek },
        },
      }),
      mainPrisma.support_disputes.count({
        where: {
          status: { in: resolvedStatuses },
          updatedAt: { gte: startOfLastWeek, lt: startOfThisWeek },
        },
      }),
      mainPrisma.support_insurance.count({
        where: {
          status: { in: resolvedStatuses },
          updatedAt: { gte: startOfLastWeek, lt: startOfThisWeek },
        },
      }),
      mainPrisma.support_report.count({
        where: {
          status: { in: resolvedStatuses },
          updatedAt: { gte: startOfLastWeek, lt: startOfThisWeek },
        },
      }),

      // This month (byType display only)
      mainPrisma.account_support.count({
        where: { createdAt: { gte: startOfMonth } },
      }),
      mainPrisma.support_disputes.count({
        where: { createdAt: { gte: startOfMonth } },
      }),
      mainPrisma.support_insurance.count({
        where: { createdAt: { gte: startOfMonth } },
      }),
      mainPrisma.support_report.count({
        where: { createdAt: { gte: startOfMonth } },
      }),

      // Live chat this week
      mainPrisma.chat_rooms.count({
        where: {
          type: "support",
          deletedAt: null,
          createdAt: { gte: startOfThisWeek },
        },
      }),
      // Live chat last week
      mainPrisma.chat_rooms.count({
        where: {
          type: "support",
          deletedAt: null,
          createdAt: { gte: startOfLastWeek, lt: startOfThisWeek },
        },
      }),
    ]);

    // ── Derived totals ──────────────────────────────────
    const allTimeTotal =
      accountTotal + disputeTotal + insuranceTotal + reportTotal;

    const thisWeekTotal =
      accountThisWeek + disputeThisWeek + insuranceThisWeek + reportThisWeek;

    const lastWeekTotal =
      accountLastWeek + disputeLastWeek + insuranceLastWeek + reportLastWeek;

    const thisWeekResolved =
      accountResolvedThisWeek +
      disputeResolvedThisWeek +
      insuranceResolvedThisWeek +
      reportResolvedThisWeek;

    const lastWeekResolved =
      accountResolvedLastWeek +
      disputeResolvedLastWeek +
      insuranceResolvedLastWeek +
      reportResolvedLastWeek;

    const thisWeekUnresolved = thisWeekTotal - thisWeekResolved;
    const lastWeekUnresolved = lastWeekTotal - lastWeekResolved;

    return {
      // "total" card shows this week's new tickets vs last week's new tickets
      total: {
        value: allTimeTotal,
        ...this._calcChange(thisWeekTotal, lastWeekTotal),
        period: "from last week",
      },
      resolved: {
        value: thisWeekResolved,
        ...this._calcChange(thisWeekResolved, lastWeekResolved),
        period: "from last week",
      },
      unresolved: {
        value: thisWeekUnresolved,
        ...this._calcChange(thisWeekUnresolved, lastWeekUnresolved),
        period: "from last week",
      },
      liveChat: {
        value: liveChatThisWeek,
        ...this._calcChange(liveChatThisWeek, liveChatLastWeek),
        period: "from last week",
      },
      byType: {
        account: { total: accountTotal, thisMonth: accountMonth },
        dispute: { total: disputeTotal, thisMonth: disputeMonth },
        insurance: { total: insuranceTotal, thisMonth: insuranceMonth },
        report: { total: reportTotal, thisMonth: reportMonth },
      },
    };
  }

  // ── Merged Tickets ────────────────────────────────────
  // Powers: RecentTickets table

  async getMergedTickets({ category, status, page = 1, limit = 50 } = {}) {
    const skip = (page - 1) * limit;

    const accountWhere = {};
    const disputeWhere = {};
    const insuranceWhere = {};
    const reportWhere = {};

    if (status) {
      accountWhere.status = status;
      disputeWhere.status = status;
      insuranceWhere.status = status;
      reportWhere.status = status;
    }

    const userSelect = {
      id: true,
      fullName: true,
      email: true,
      role: true,
      status: true,
      profileImageUrl: true,
    };

    const [accounts, disputes, insurances, reports] = await Promise.all([
      !category || category === "account"
        ? mainPrisma.account_support.findMany({
            where: accountWhere,
            include: { users: { select: userSelect } },
            orderBy: { createdAt: "desc" },
          })
        : [],
      !category || category === "dispute"
        ? mainPrisma.support_disputes.findMany({
            where: disputeWhere,
            include: { users: { select: userSelect } },
            orderBy: { createdAt: "desc" },
          })
        : [],
      !category || category === "insurance"
        ? mainPrisma.support_insurance.findMany({
            where: insuranceWhere,
            include: { users: { select: userSelect } },
            orderBy: { createdAt: "desc" },
          })
        : [],
      !category || category === "report"
        ? mainPrisma.support_report.findMany({
            where: reportWhere,
            include: { users: { select: userSelect } },
            orderBy: { createdAt: "desc" },
          })
        : [],
    ]);

    const merged = [
      ...accounts.map((t) => ({ ...t, ticketCategory: "account" })),
      ...disputes.map((t) => ({ ...t, ticketCategory: "dispute" })),
      ...insurances.map((t) => ({ ...t, ticketCategory: "insurance" })),
      ...reports.map((t) => ({ ...t, ticketCategory: "report" })),
    ];

    merged.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const total = merged.length;
    const paginated = merged.slice(skip, skip + Number(limit));

    return {
      tickets: paginated,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: Number(limit),
      },
    };
  }

  // ── User Traffic ──────────────────────────────────────
  // Powers: UserTrafficChart

  async getUserTraffic() {
    const days = await Promise.all(
      Array.from({ length: 7 }, (_, i) => {
        const start = this._getStartOfDay(6 - i);
        const end = this._getEndOfDay(6 - i);
        return mainPrisma.auth_events
          .count({
            where: {
              eventType: "login",
              timestamp: { gte: start, lte: end },
            },
          })
          .then((count) => ({
            day: start.toLocaleDateString("en-GB", { weekday: "short" }),
            value: count,
          }));
      }),
    );

    const total = days.reduce((sum, d) => sum + d.value, 0);
    const avg = total === 0 ? 0 : Math.round(total / 7);

    return { days, total, avgPerDay: avg };
  }

  // ── Chat ──────────────────────────────────────────────

  async getSupportChats() {
    const rooms = await mainPrisma.chat_rooms.findMany({
      where: { type: "support", deletedAt: null },
      include: {
        chat_participants: {
          include: {
            users_chat_participants_userIdTousers: {
              select: {
                id: true,
                fullName: true,
                email: true,
                profileImageUrl: true,
                role: true,
              },
            },
          },
          where: { isActive: true },
        },
        chat_messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            content: true,
            createdAt: true,
            type: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return rooms.map((room) => {
      const u = (p) => p.users_chat_participants_userIdTousers;

      const patient = room.chat_participants.find(
        (p) => u(p).role !== "admin" && u(p).role !== "super_admin",
      );
      const agent = room.chat_participants.find(
        (p) => u(p).role === "admin" || u(p).role === "super_admin",
      );

      return {
        id: room.id,
        name: room.name,
        createdAt: room.createdAt,
        isClaimed: !!agent,
        patient: patient
          ? {
              id: u(patient).id,
              name: u(patient).fullName,
              email: u(patient).email,
              avatar: u(patient).profileImageUrl,
            }
          : null,
        agent: agent
          ? {
              id: u(agent).id,
              name: u(agent).fullName,
              email: u(agent).email,
            }
          : null,
        lastMessage: room.chat_messages[0] ?? null,
      };
    });
  }

  async getChatMessages(roomId) {
    const room = await mainPrisma.chat_rooms.findFirst({
      where: { id: roomId, type: "support", deletedAt: null },
    });
    if (!room) throw new ApiError(404, "Support chat not found");

    const messages = await mainPrisma.chat_messages.findMany({
      where: { roomId, deleted: false },
      include: {
        users: {
          select: {
            id: true,
            fullName: true,
            profileImageUrl: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return messages;
  }

  async claimChat(roomId, adminUser) {
    if (!adminUser.mainAppUserId) {
      throw new ApiError(
        403,
        "Your account is not linked to the main app. Contact a Super admin.",
      );
    }

    const room = await mainPrisma.chat_rooms.findFirst({
      where: { id: roomId, type: "support", deletedAt: null },
      include: {
        chat_participants: {
          include: {
            users_chat_participants_userIdTousers: {
              select: { role: true },
            },
          },
          where: { isActive: true },
        },
      },
    });
    if (!room) throw new ApiError(404, "Support chat not found");

    const u = (p) => p.users_chat_participants_userIdTousers;

    const existingAgent = room.chat_participants.find(
      (p) => u(p).role === "admin" || u(p).role === "super_admin",
    );
    if (existingAgent && existingAgent.userId !== adminUser.mainAppUserId) {
      throw new ApiError(
        409,
        "This chat has already been claimed by another agent",
      );
    }
    if (existingAgent && existingAgent.userId === adminUser.mainAppUserId) {
      return { message: "Already claimed by you", roomId };
    }

    try {
      await mainPrisma.chat_participants.create({
        data: {
          userId: adminUser.mainAppUserId,
          roomId,
          role: "admin",
          isActive: true,
        },
      });
    } catch (err) {
      if (err.code === "P2002") {
        return { message: "Already claimed by you", roomId };
      }
      throw err;
    }

    await mainPrisma.chat_messages.create({
      data: {
        roomId,
        senderId: adminUser.mainAppUserId,
        content: `${adminUser.name} from Support is now handling your chat.`,
        type: "system",
      },
    });

    return { message: "Chat claimed successfully", roomId };
  }

  async sendChatMessage(roomId, adminUser, content) {
    if (!adminUser.mainAppUserId) {
      throw new ApiError(
        403,
        "Your account is not linked to the main app. Contact a Super admin.",
      );
    }

    const participant = await mainPrisma.chat_participants.findFirst({
      where: {
        roomId,
        userId: adminUser.mainAppUserId,
        isActive: true,
      },
    });
    if (!participant) {
      throw new ApiError(
        403,
        "You have not claimed this chat. Claim it first before sending messages.",
      );
    }

    const message = await mainPrisma.chat_messages.create({
      data: {
        roomId,
        senderId: adminUser.mainAppUserId,
        content,
        type: "text",
      },
      include: {
        users: {
          select: {
            id: true,
            fullName: true,
            profileImageUrl: true,
            role: true,
          },
        },
      },
    });

    return message;
  }
}

module.exports = new SupportService();
