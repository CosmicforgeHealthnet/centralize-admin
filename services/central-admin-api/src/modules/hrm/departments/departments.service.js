const { prisma } = require("../../../shared/config/database");
const { accountRole } = require("../../../shared/auth/effective-access");
const {
  buildMeta,
  formatEnumLabel,
  normalizeDepartment,
  paginate,
} = require("../hrm.utils");

const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  avatarUrl: true,
  employmentType: true,
  employmentCategory: true,
  createdAt: true,
};

function formatEmploymentType(user) {
  const parts = [user.employmentType, user.employmentCategory].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function mapEmployee(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    employeeCode: null,
    employmentType: formatEmploymentType(user),
    department: user.department,
    designation: user.position,
    avatarUrl: user.avatarUrl,
    employmentDate: user.createdAt,
  };
}

const DIRECTORY_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  avatarUrl: true,
  tier: true,
  isTeamLead: true,
};

function mapColleague(user, scope) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    department: user.department,
    jobTitle: user.position,
    designation: user.position,
    avatarUrl: user.avatarUrl,
    role: accountRole(user),
    ...(scope.roster ? { status: user.status } : {}),
  };
}

class DepartmentsService {
  async getDepartments() {
    const [total, grouped] = await Promise.all([
      prisma.adminUser.count(),
      prisma.adminUser.groupBy({
        by: ["department"],
        _count: { _all: true },
        orderBy: { department: "asc" },
      }),
    ]);

    return [
      { id: "all", label: "All Departments", count: total },
      ...grouped
        .filter((row) => row.department)
        .map((row) => ({
          id: row.department,
          label: formatEnumLabel(row.department),
          count: row._count._all,
        })),
    ];
  }

  // scope = null: HR view (any department). scope = { department, roster }:
  // an employee's own-department directory (basic work information only).
  async getDepartmentEmployees({ dept, query = {}, scope = null }) {
    const { page, limit, skip } = paginate(query, 15, 100);
    const normalizedDept = scope
      ? scope.department
      : String(dept || "").toLowerCase() === "all"
        ? "all"
        : normalizeDepartment(dept);

    const where = normalizedDept === "all" ? {} : { department: normalizedDept };
    if (scope && !scope.roster) where.status = "ACTIVE";

    const select = scope
      ? { ...DIRECTORY_SELECT, ...(scope.roster ? { status: true } : {}) }
      : EMPLOYEE_SELECT;

    const [total, employees] = await Promise.all([
      prisma.adminUser.count({ where }),
      prisma.adminUser.findMany({
        where,
        select,
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: scope ? employees.map((user) => mapColleague(user, scope)) : employees.map(mapEmployee),
      meta: buildMeta(total, page, limit),
    };
  }
}

module.exports = new DepartmentsService();
