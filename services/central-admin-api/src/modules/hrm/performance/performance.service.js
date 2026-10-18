const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const { createAuditLog } = require("../../../shared/middlewares/audit.middleware");
const {
  assertUuid,
  buildMeta,
  formatDateOnly,
  normalizeDepartment,
  normalizeEnum,
  paginate,
  percentageChange,
  unsupportedEndpoint,
} = require("../hrm.utils");

// Resolve event delegate at load time: use Event if present, fall back to HrmEvent.
// Throws 501 at the call site only when neither model exists in the generated client.
function resolveEventDelegate() {
  if (prisma.event && typeof prisma.event.findMany === "function") return prisma.event;
  if (prisma.hrmEvent && typeof prisma.hrmEvent.findMany === "function") return prisma.hrmEvent;
  return null;
}

const eventDelegate = resolveEventDelegate();

function assertEventDelegate() {
  if (!eventDelegate) unsupportedEndpoint("Performance events", ["Event", "HrmEvent"]);
  return eventDelegate;
}

const TASK_STATUSES = ["IN_PROGRESS", "COMPLETED", "OVERDUE"];
const PROJECT_STATUSES = ["IN_PROGRESS", "COMPLETED", "OVERDUE"];
const EMPLOYEE_STATUSES = ["ACTIVE", "INACTIVE", "LOCKED", "PENDING"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function barColor(value) {
  if (value >= 70) return "#0DA53F";
  if (value >= 40) return "#F59E0B";
  return "#EF4444";
}

function searchWhere(search, fields) {
  if (!search) return {};
  return { OR: fields.map((field) => ({ [field]: { contains: search, mode: "insensitive" } })) };
}

function teamContext(project) {
  const team = project.team || {};
  const teamLead = (team.members || []).find((m) => m.isTeamLead)?.adminUser;
  return {
    team: team.title || null,
    teamLead: teamLead?.name || null,
    members: team._count?.members || 0,
  };
}

const PROJECT_WITH_TEAM_INCLUDE = {
  team: {
    include: {
      members: { include: { adminUser: { select: { name: true } } } },
      _count: { select: { members: true } },
    },
  },
};

class PerformanceService {
  async getStats() {
    const now = new Date();
    const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

    const [
      totalEmployees, totalTeams, totalTasks, totalProjects, totalEvents,
      empThis, empPrev,
      teamThis, teamPrev,
      taskThis, taskPrev,
      projThis, projPrev,
      eventThis, eventPrev,
    ] = await Promise.all([
      prisma.adminUser.count(),
      prisma.team.count(),
      prisma.task.count(),
      prisma.project.count(),
      eventDelegate ? eventDelegate.count() : Promise.resolve(0),
      prisma.adminUser.count({ where: { createdAt: { gte: thisMonthStart } } }),
      prisma.adminUser.count({ where: { createdAt: { gte: prevMonthStart, lt: thisMonthStart } } }),
      prisma.team.count({ where: { createdAt: { gte: thisMonthStart } } }),
      prisma.team.count({ where: { createdAt: { gte: prevMonthStart, lt: thisMonthStart } } }),
      prisma.task.count({ where: { createdAt: { gte: thisMonthStart } } }),
      prisma.task.count({ where: { createdAt: { gte: prevMonthStart, lt: thisMonthStart } } }),
      prisma.project.count({ where: { createdAt: { gte: thisMonthStart } } }),
      prisma.project.count({ where: { createdAt: { gte: prevMonthStart, lt: thisMonthStart } } }),
      eventDelegate ? eventDelegate.count({ where: { createdAt: { gte: thisMonthStart } } }) : Promise.resolve(0),
      eventDelegate ? eventDelegate.count({ where: { createdAt: { gte: prevMonthStart, lt: thisMonthStart } } }) : Promise.resolve(0),
    ]);

    return {
      totalEmployees,
      totalTeams,
      totalTasks,
      totalProjects,
      totalEvents,
      changes: {
        employeesChange: percentageChange(empThis, empPrev),
        teamsChange: percentageChange(teamThis, teamPrev),
        tasksChange: percentageChange(taskThis, taskPrev),
        projectsChange: percentageChange(projThis, projPrev),
        eventsChange: percentageChange(eventThis, eventPrev),
      },
    };
  }

  async getScore() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      projectTotal, completedProjects,
      taskTotal, completedTasks,
      totalAttendance, presentAttendance,
      upcomingEvent,
    ] = await Promise.all([
      prisma.project.count(),
      prisma.project.count({ where: { status: "COMPLETED" } }),
      prisma.task.count(),
      prisma.task.count({ where: { status: "COMPLETED" } }),
      prisma.attendanceLog.count({ where: { date: { gte: thirtyDaysAgo } } }),
      prisma.attendanceLog.count({ where: { status: "PRESENT", date: { gte: thirtyDaysAgo } } }),
      eventDelegate
        ? eventDelegate.findFirst({
            where: { date: { gte: now } },
            orderBy: { date: "asc" },
            select: { id: true, title: true, date: true, time: true },
          })
        : Promise.resolve(null),
    ]);

    const timeline = percent(completedProjects, projectTotal);
    const execution = percent(completedTasks, taskTotal);
    const attendance = percent(presentAttendance, totalAttendance);
    const score = Math.round((timeline + execution + attendance) / 3);

    return {
      score,
      bars: [
        { label: "Project Timeline", value: timeline, color: barColor(timeline) },
        { label: "Execution", value: execution, color: barColor(execution) },
        { label: "Attendance", value: attendance, color: barColor(attendance) },
      ],
      upcomingEvent: upcomingEvent
        ? { id: upcomingEvent.id, title: upcomingEvent.title, date: formatDateOnly(upcomingEvent.date), time: upcomingEvent.time }
        : null,
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
        assignee: { select: { department: true } },
      },
    });

    const buckets = Array.from({ length: 12 }, () => ({
      MARKETING: { total: 0, completed: 0 },
      DEVELOPMENT: { total: 0, completed: 0 },
      SOCIAL_MEDIA: { total: 0, completed: 0 },
    }));

    for (const task of tasks) {
      const monthIndex = task.createdAt.getUTCMonth();
      const dept = task.assignee?.department;
      if (dept && buckets[monthIndex][dept] !== undefined) {
        buckets[monthIndex][dept].total += 1;
        if (task.status === "COMPLETED") buckets[monthIndex][dept].completed += 1;
      }
    }

    if (!tasks.length) return { data: [] };

    return {
      data: buckets.map((b, i) => ({
        month: MONTHS[i],
        marketing: percent(b.MARKETING.completed, b.MARKETING.total),
        development: percent(b.DEVELOPMENT.completed, b.DEVELOPMENT.total),
        socialMedia: percent(b.SOCIAL_MEDIA.completed, b.SOCIAL_MEDIA.total),
      })),
    };
  }

  async getTasks(query = {}) {
    const { page, limit, skip } = paginate(query, 8, 100);
    const where = { ...searchWhere(String(query.search || "").trim(), ["title", "description"]) };
    const department = normalizeDepartment(query.department);
    if (department) where.assignee = { is: { department } };
    const status = normalizeEnum(query.status, TASK_STATUSES, "status");
    if (status) where.status = status;

    const [total, tasks] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({
        where,
        include: { assignee: { select: { name: true, email: true, department: true } } },
        orderBy: { assignedDate: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        assignee: {
          name: t.assignee?.name || null,
          email: t.assignee?.email || null,
          employeeCode: null,
          department: t.assignee?.department || null,
        },
        assignedDate: formatDateOnly(t.assignedDate),
        dueDate: formatDateOnly(t.dueDate),
        status: t.status,
      })),
      meta: buildMeta(total, page, limit),
    };
  }

  async getTeams(query = {}) {
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = { ...searchWhere(String(query.search || "").trim(), ["title", "description"]) };
    const status = normalizeEnum(query.status, PROJECT_STATUSES, "status");
    if (status) where.status = status;

    const [total, projects] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        include: PROJECT_WITH_TEAM_INCLUDE,
        orderBy: { assignedDate: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: projects.map((p) => ({
        id: p.id,
        projectTitle: p.title,
        ...teamContext(p),
        assignedDate: formatDateOnly(p.assignedDate),
        dueDate: formatDateOnly(p.dueDate),
        status: p.status,
      })),
      meta: buildMeta(total, page, limit),
    };
  }

  async getProjects(query = {}) {
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = { ...searchWhere(String(query.search || "").trim(), ["title", "description"]) };
    const status = normalizeEnum(query.status, PROJECT_STATUSES, "status");
    if (status) where.status = status;

    const [total, projects] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        include: PROJECT_WITH_TEAM_INCLUDE,
        orderBy: { assignedDate: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: projects.map((p) => ({
        id: p.id,
        title: p.title,
        ...teamContext(p),
        assignedDate: formatDateOnly(p.assignedDate),
        dueDate: formatDateOnly(p.dueDate),
        status: p.status,
      })),
      meta: buildMeta(total, page, limit),
    };
  }

  async getEmployees(query = {}) {
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = { ...searchWhere(String(query.search || "").trim(), ["name", "email", "position"]) };
    const department = normalizeDepartment(query.department);
    if (department) where.department = department;
    const status = normalizeEnum(query.status, EMPLOYEE_STATUSES, "status");
    if (status) where.status = status;

    const [total, employees] = await Promise.all([
      prisma.adminUser.count({ where }),
      prisma.adminUser.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          department: true,
          assignedTasks: {
            select: { title: true, assignedDate: true, dueDate: true, status: true },
            orderBy: { assignedDate: "desc" },
            take: 1,
          },
        },
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: employees.map((e) => {
        const task = e.assignedTasks?.[0] || null;
        return {
          id: e.id,
          name: e.name,
          email: e.email,
          employeeCode: null,
          department: e.department || null,
          task: task?.title || null,
          assignedDate: formatDateOnly(task?.assignedDate),
          dueDate: formatDateOnly(task?.dueDate),
          status: task?.status || null,
        };
      }),
      meta: buildMeta(total, page, limit),
    };
  }

  async getEvents() {
    const now = new Date();
    const events = await assertEventDelegate().findMany({
      where: { date: { gte: now } },
      orderBy: { date: "asc" },
    });

    return {
      data: events.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description || null,
        date: formatDateOnly(e.date),
        time: e.time,
        location: e.location || null,
      })),
    };
  }

  async createEvent({ data, actor, req }) {
    assertEventDelegate();
    const date = new Date(data.date);
    if (Number.isNaN(date.getTime())) throw new ApiError(400, "Invalid date.");

    const event = await assertEventDelegate().create({
      data: {
        title: data.title,
        description: data.description || null,
        date,
        time: data.time,
        location: data.location || null,
      },
      select: { id: true },
    });

    await createAuditLog({
      adminUserId: actor?.id,
      action: "HRM_EVENT_CREATED",
      targetId: event.id,
      targetType: "event",
      metadata: { title: data.title },
      req,
    });

    return { id: event.id };
  }

  async getEvent(id) {
    assertEventDelegate();
    const eventId = assertUuid(id, "event id");
    const event = await assertEventDelegate().findUnique({ where: { id: eventId } });
    if (!event) throw new ApiError(404, "Event not found");

    return {
      id: event.id,
      title: event.title,
      description: event.description || null,
      date: formatDateOnly(event.date),
      time: event.time,
      location: event.location || null,
    };
  }
}

module.exports = new PerformanceService();
