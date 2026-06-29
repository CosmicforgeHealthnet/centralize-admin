const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const {
  assertUuid,
  buildMeta,
  normalizeDepartment,
  normalizeEnum,
  paginate,
  unsupportedEndpoint,
} = require("../hrm.utils");

const TASK_STATUSES = ["IN_PROGRESS", "COMPLETED", "OVERDUE"];
const PROJECT_STATUSES = ["IN_PROGRESS", "COMPLETED", "OVERDUE"];

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

async function monthlyChange(delegate) {
  const now = new Date();
  const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const [current, previous] = await Promise.all([
    delegate.count({ where: { createdAt: { gte: currentStart } } }),
    delegate.count({
      where: {
        createdAt: {
          gte: previousStart,
          lt: currentStart,
        },
      },
    }),
  ]);

  return {
    current,
    previous,
    percentage: previous === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - previous) / previous) * 100),
  };
}

function searchWhere(search, fields) {
  if (!search) return {};
  return {
    OR: fields.map((field) => ({
      [field]: { contains: search, mode: "insensitive" },
    })),
  };
}

class PerformanceService {
  async getStats() {
    const [totalEmployees, totalTeams, totalTasks, totalProjects, changes] = await Promise.all([
      prisma.adminUser.count(),
      prisma.team.count(),
      prisma.task.count(),
      prisma.project.count(),
      Promise.all([
        monthlyChange(prisma.adminUser),
        monthlyChange(prisma.team),
        monthlyChange(prisma.task),
        monthlyChange(prisma.project),
      ]),
    ]);

    return {
      totalEmployees,
      totalTeams,
      totalTasks,
      totalProjects,
      totalEvents: null,
      changes: {
        employees: changes[0],
        teams: changes[1],
        tasks: changes[2],
        projects: changes[3],
        events: null,
      },
      schemaBlockers: ["Event model is missing from prisma/schema.prisma"],
    };
  }

  async getScore() {
    const [projectTotal, completedProjects, taskTotal, completedTasks, overdueTasks] =
      await Promise.all([
        prisma.project.count(),
        prisma.project.count({ where: { status: "COMPLETED" } }),
        prisma.task.count(),
        prisma.task.count({ where: { status: "COMPLETED" } }),
        prisma.task.count({ where: { status: "OVERDUE" } }),
      ]);

    const timeline = percent(completedProjects, projectTotal);
    const execution = percent(completedTasks, taskTotal);
    const attendance = null;
    const score = Math.round(
      [timeline, execution].reduce((sum, value) => sum + value, 0) / 2,
    );

    return {
      score,
      bars: [
        { label: "Project Timeline", value: timeline },
        { label: "Execution", value: execution },
        { label: "Attendance", value: attendance },
      ],
      upcomingEvent: null,
      overdueTasks,
      schemaBlockers: ["Attendance and Event models are missing from prisma/schema.prisma"],
    };
  }

  async getChart() {
    const year = new Date().getUTCFullYear();
    const tasks = await prisma.task.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lt: new Date(Date.UTC(year + 1, 0, 1)),
        },
      },
      select: {
        status: true,
        createdAt: true,
        assignee: {
          select: { department: true },
        },
      },
    });

    const buckets = new Map();
    for (const task of tasks) {
      const key = `${task.createdAt.getUTCMonth()}-${task.assignee?.department || "UNASSIGNED"}`;
      const bucket = buckets.get(key) || { total: 0, completed: 0 };
      bucket.total += 1;
      if (task.status === "COMPLETED") bucket.completed += 1;
      buckets.set(key, bucket);
    }

    return {
      year,
      data: Array.from(buckets.entries()).map(([key, value]) => {
        const [monthIndex, department] = key.split("-");
        return {
          month: MONTHS[Number(monthIndex)],
          department,
          value: percent(value.completed, value.total),
          totalTasks: value.total,
          completedTasks: value.completed,
        };
      }),
    };
  }

  async getTasks(query = {}) {
    const { page, limit, skip } = paginate(query, 8, 100);
    const where = {
      ...searchWhere(String(query.search || "").trim(), ["title", "description"]),
    };
    const department = normalizeDepartment(query.department);
    if (department) where.assignee = { is: { department } };
    const status = normalizeEnum(query.status, TASK_STATUSES, "status");
    if (status) where.status = status;

    const [total, tasks] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({
        where,
        include: {
          assignee: { select: { id: true, name: true, email: true, department: true, avatarUrl: true } },
          assigner: { select: { id: true, name: true, email: true } },
          project: { select: { id: true, title: true, status: true } },
        },
        orderBy: { assignedDate: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return { tasks, meta: buildMeta(total, page, limit) };
  }

  async getTeams(query = {}) {
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = {
      ...searchWhere(String(query.search || "").trim(), ["title"]),
    };

    const [total, teams] = await Promise.all([
      prisma.team.count({ where }),
      prisma.team.findMany({
        where,
        include: {
          members: {
            include: { adminUser: { select: { id: true, name: true, avatarUrl: true } } },
          },
          _count: { select: { projects: true, members: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      teams,
      meta: buildMeta(total, page, limit),
      schemaBlockers: query.status ? ["Team.status field is missing from prisma/schema.prisma"] : [],
    };
  }

  async getProjects(query = {}) {
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = {
      ...searchWhere(String(query.search || "").trim(), ["title", "description"]),
    };
    const status = normalizeEnum(query.status, PROJECT_STATUSES, "status");
    if (status) where.status = status;

    const [total, projects] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        include: {
          team: { select: { id: true, title: true, department: true } },
          _count: { select: { assignees: true, tasks: true } },
        },
        orderBy: { assignedDate: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return { projects, meta: buildMeta(total, page, limit) };
  }

  async getEmployees(query = {}) {
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = {
      ...searchWhere(String(query.search || "").trim(), ["name", "email", "position"]),
    };
    const department = normalizeDepartment(query.department);
    if (department) where.department = department;
    if (query.status) where.status = String(query.status).trim().toUpperCase();

    const [total, employees] = await Promise.all([
      prisma.adminUser.count({ where }),
      prisma.adminUser.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          position: true,
          department: true,
          status: true,
          tier: true,
          avatarUrl: true,
          _count: { select: { assignedTasks: true, projectMemberships: true, teamMemberships: true } },
        },
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
    ]);

    return { employees, meta: buildMeta(total, page, limit) };
  }

  async getEvents() {
    unsupportedEndpoint("Performance events", ["Event"]);
  }

  async createEvent() {
    unsupportedEndpoint("Performance event creation", ["Event"]);
  }

  async getEvent(id) {
    assertUuid(id, "event id");
    unsupportedEndpoint("Performance event detail", ["Event"]);
  }
}

module.exports = new PerformanceService();
