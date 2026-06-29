const { prisma } = require("../../../shared/config/database");
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
    employmentCategory: user.employmentCategory,
    department: user.department,
    designation: user.position,
    avatarUrl: user.avatarUrl,
    employmentDate: user.createdAt,
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

  async getDepartmentEmployees({ dept, query = {} }) {
    const { page, limit, skip } = paginate(query, 15, 100);
    const normalizedDept = String(dept || "").toLowerCase() === "all"
      ? "all"
      : normalizeDepartment(dept);

    const where = normalizedDept === "all" ? {} : { department: normalizedDept };

    const [total, employees] = await Promise.all([
      prisma.adminUser.count({ where }),
      prisma.adminUser.findMany({
        where,
        select: EMPLOYEE_SELECT,
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: employees.map(mapEmployee),
      meta: buildMeta(total, page, limit),
    };
  }
}

module.exports = new DepartmentsService();
