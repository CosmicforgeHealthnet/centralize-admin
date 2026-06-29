const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const { createAuditLog } = require("../../../shared/middlewares/audit.middleware");
const {
  assertSelfOrTier,
  assertSensitiveTier,
  assertUuid,
  buildMeta,
  decimalInput,
  destroyCloudinaryResource,
  isSensitiveTier,
  normalizeDepartment,
  numberOrNull,
  paginate,
  parseDate,
  pickDefined,
  uploadBufferToCloudinary,
} = require("../hrm.utils");

const EMPLOYEE_LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  tier: true,
  status: true,
  avatarUrl: true,
  employmentType: true,
  employmentCategory: true,
  location: true,
  createdAt: true,
};

const EMPLOYEE_DETAIL_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  tier: true,
  status: true,
  isTeamLead: true,
  avatarUrl: true,
  avatarCloudinaryId: true,
  preferredName: true,
  birthday: true,
  nationality: true,
  gender: true,
  maritalStatus: true,
  workPhone: true,
  homePhone: true,
  personalPhone: true,
  fax: true,
  address: true,
  state: true,
  country: true,
  emergencyName: true,
  emergencyPhone: true,
  emergencyEmail: true,
  emergencyRelation: true,
  employmentType: true,
  employmentCategory: true,
  location: true,
  salary: true,
  bonus: true,
  equity: true,
  createdAt: true,
  updatedAt: true,
  socialLinks: {
    select: { id: true, platform: true, username: true },
    orderBy: { createdAt: "asc" },
  },
  educations: {
    select: {
      id: true,
      degreeTitle: true,
      institution: true,
      from: true,
      to: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  },
  documents: {
    select: {
      id: true,
      name: true,
      type: true,
      url: true,
      uploadedBy: true,
      uploadedAt: true,
    },
    orderBy: { uploadedAt: "desc" },
  },
  performanceNotes: {
    select: {
      id: true,
      title: true,
      type: true,
      url: true,
      createdBy: true,
      date: true,
    },
    orderBy: { date: "desc" },
  },
  reports: {
    select: {
      id: true,
      title: true,
      type: true,
      body: true,
      note: true,
      url: true,
      createdBy: true,
      date: true,
    },
    orderBy: { date: "desc" },
  },
  teamMemberships: {
    select: {
      isTeamLead: true,
      joinedAt: true,
      team: {
        select: { id: true, title: true, department: true },
      },
    },
  },
  projectMemberships: {
    select: {
      assignedAt: true,
      project: {
        select: {
          id: true,
          title: true,
          description: true,
          assignedDate: true,
          dueDate: true,
          status: true,
        },
      },
    },
  },
  assignedTasks: {
    select: {
      id: true,
      title: true,
      description: true,
      assignedDate: true,
      dueDate: true,
      status: true,
    },
    orderBy: { assignedDate: "desc" },
  },
};

function mapEmployeeListItem(user) {
  return {
    id: user.id,
    employeeCode: null,
    name: user.name,
    email: user.email,
    department: user.department,
    designation: user.position,
    position: user.position,
    employmentType: user.employmentType,
    employmentCategory: user.employmentCategory,
    location: user.location,
    tier: user.tier,
    status: user.status,
    avatarUrl: user.avatarUrl,
    employmentDate: user.createdAt,
  };
}

function mapEmployeeDetail(user, canReadSensitive) {
  const profile = {
    id: user.id,
    employeeCode: null,
    name: user.name,
    email: user.email,
    tier: user.tier,
    status: user.status,
    avatarUrl: user.avatarUrl,
    personalInfo: {
      preferredName: user.preferredName,
      birthday: user.birthday,
      nationality: user.nationality,
      gender: user.gender,
      maritalStatus: user.maritalStatus,
    },
    contactInfo: {
      workPhone: user.workPhone,
      homePhone: user.homePhone,
      personalPhone: user.personalPhone,
      fax: user.fax,
      address: user.address,
      state: user.state,
      country: user.country,
    },
    employmentInfo: {
      employmentDate: user.createdAt,
      position: user.position,
      jobTitle: user.position,
      designation: user.position,
      department: user.department,
      location: user.location,
      headOfDepartment: null,
      employmentType: user.employmentType,
      employmentCategory: user.employmentCategory,
      isTeamLead: user.isTeamLead,
    },
    emergencyContact: {
      name: user.emergencyName,
      phone: user.emergencyPhone,
      email: user.emergencyEmail,
      relation: user.emergencyRelation,
    },
    socialLinks: user.socialLinks,
    education: user.educations,
    documents: user.documents,
    reports: user.reports,
    performanceNotes: user.performanceNotes,
    teams: user.teamMemberships.map((membership) => ({
      id: membership.team.id,
      title: membership.team.title,
      department: membership.team.department,
      isTeamLead: membership.isTeamLead,
      joinedAt: membership.joinedAt,
    })),
    projects: user.projectMemberships.map((membership) => ({
      ...membership.project,
      assignedAt: membership.assignedAt,
    })),
    tasks: user.assignedTasks,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  if (canReadSensitive) {
    profile.sensitive = {
      salary: numberOrNull(user.salary),
      bonus: numberOrNull(user.bonus),
      equity: numberOrNull(user.equity),
    };
  }

  return profile;
}

function buildEmployeeWhere(query = {}, actor) {
  const where = {};

  if (actor?.tier === "EMPLOYEE") {
    where.id = actor.id;
    return where;
  }

  const department = normalizeDepartment(query.department);
  if (department) where.department = department;

  const search = String(query.search || "").trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }

  return where;
}

class EmployeesService {
  async listEmployees({ query = {}, actor }) {
    const { page, limit, skip } = paginate(query, 20, 100);
    const where = buildEmployeeWhere(query, actor);

    const [total, employees] = await Promise.all([
      prisma.adminUser.count({ where }),
      prisma.adminUser.findMany({
        where,
        select: EMPLOYEE_LIST_SELECT,
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      employees: employees.map(mapEmployeeListItem),
      meta: buildMeta(total, page, limit),
    };
  }

  async getEmployee({ id, actor }) {
    const employeeId = assertUuid(id, "employee id");
    assertSelfOrTier(actor, employeeId, "ADMIN");

    const employee = await prisma.adminUser.findUnique({
      where: { id: employeeId },
      select: EMPLOYEE_DETAIL_SELECT,
    });

    if (!employee) throw new ApiError(404, "Employee not found");
    return mapEmployeeDetail(employee, isSensitiveTier(actor));
  }

  async updatePersonal({ id, actor, data, req }) {
    const employeeId = assertUuid(id, "employee id");
    assertSelfOrTier(actor, employeeId, "ADMIN");

    const update = pickDefined(data, [
      "name",
      "preferredName",
      "birthday",
      "nationality",
      "gender",
      "maritalStatus",
    ]);
    if (update.birthday !== undefined) update.birthday = parseDate(update.birthday, "birthday") || null;

    const updated = await prisma.adminUser.update({
      where: { id: employeeId },
      data: update,
      select: EMPLOYEE_DETAIL_SELECT,
    });

    await this.auditProfileUpdate({ actor, employeeId, section: "personal", changes: update, req });
    return mapEmployeeDetail(updated, isSensitiveTier(actor));
  }

  async updateContact({ id, actor, data, req }) {
    const employeeId = assertUuid(id, "employee id");
    assertSelfOrTier(actor, employeeId, "ADMIN");
    const update = pickDefined(data, [
      "workPhone",
      "homePhone",
      "personalPhone",
      "fax",
      "address",
      "state",
      "country",
    ]);

    const updated = await prisma.adminUser.update({
      where: { id: employeeId },
      data: update,
      select: EMPLOYEE_DETAIL_SELECT,
    });

    await this.auditProfileUpdate({ actor, employeeId, section: "contact", changes: update, req });
    return mapEmployeeDetail(updated, isSensitiveTier(actor));
  }

  async updateEmployment({ id, actor, data, req }) {
    const employeeId = assertUuid(id, "employee id");
    assertSensitiveTier(actor);

    const update = pickDefined(data, [
      "position",
      "department",
      "employmentType",
      "employmentCategory",
      "location",
      "isTeamLead",
      "tier",
      "status",
    ]);

    const updated = await prisma.adminUser.update({
      where: { id: employeeId },
      data: update,
      select: EMPLOYEE_DETAIL_SELECT,
    });

    await this.auditProfileUpdate({ actor, employeeId, section: "employment", changes: update, req });
    return mapEmployeeDetail(updated, isSensitiveTier(actor));
  }

  async updateEmergency({ id, actor, data, req }) {
    const employeeId = assertUuid(id, "employee id");
    assertSelfOrTier(actor, employeeId, "ADMIN");
    const update = pickDefined(data, [
      "emergencyName",
      "emergencyPhone",
      "emergencyEmail",
      "emergencyRelation",
    ]);

    const updated = await prisma.adminUser.update({
      where: { id: employeeId },
      data: update,
      select: EMPLOYEE_DETAIL_SELECT,
    });

    await this.auditProfileUpdate({ actor, employeeId, section: "emergency", changes: update, req });
    return mapEmployeeDetail(updated, isSensitiveTier(actor));
  }

  async updateSocial({ id, actor, links, req }) {
    const employeeId = assertUuid(id, "employee id");
    assertSelfOrTier(actor, employeeId, "ADMIN");
    await this.ensureEmployee(employeeId);

    await prisma.$transaction(async (tx) => {
      await tx.adminSocialLink.deleteMany({ where: { adminUserId: employeeId } });
      if (links.length) {
        await tx.adminSocialLink.createMany({
          data: links.map((link) => ({
            adminUserId: employeeId,
            platform: link.platform,
            username: link.username,
          })),
        });
      }
    });

    await this.auditProfileUpdate({
      actor,
      employeeId,
      section: "social",
      changes: { count: links.length },
      req,
    });

    return prisma.adminSocialLink.findMany({
      where: { adminUserId: employeeId },
      select: { id: true, platform: true, username: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async updateSensitive({ id, actor, data, req }) {
    const employeeId = assertUuid(id, "employee id");
    assertSensitiveTier(actor);

    const update = {};
    for (const key of ["salary", "bonus", "equity"]) {
      if (data[key] !== undefined) update[key] = decimalInput(data[key]);
    }

    await prisma.$transaction(async (tx) => {
      await tx.adminUser.update({ where: { id: employeeId }, data: update });
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: "PROFILE_UPDATED",
      targetId: employeeId,
      targetType: "admin_user",
      metadata: { section: "sensitive", changedFields: Object.keys(update) },
      req,
    });
  }

  async updateAvatar({ id, actor, file, req }) {
    const employeeId = assertUuid(id, "employee id");
    assertSelfOrTier(actor, employeeId, "ADMIN");
    if (!file) {
      throw new ApiError(400, "No image uploaded. Use multipart/form-data field 'avatar'.");
    }

    const existing = await prisma.adminUser.findUnique({
      where: { id: employeeId },
      select: { avatarCloudinaryId: true },
    });
    if (!existing) throw new ApiError(404, "Employee not found");

    const uploaded = await uploadBufferToCloudinary(file, {
      folder: "hrm/avatars",
      public_id: `avatar-${employeeId}-${Date.now()}`,
      resource_type: "image",
      transformation: [{ width: 400, height: 400, crop: "fill", gravity: "face" }],
    });

    const updated = await prisma.adminUser.update({
      where: { id: employeeId },
      data: {
        avatarUrl: uploaded.secure_url,
        avatarCloudinaryId: uploaded.public_id,
      },
      select: { id: true, avatarUrl: true },
    });

    if (existing.avatarCloudinaryId) {
      await destroyCloudinaryResource(existing.avatarCloudinaryId, "image");
    }

    await createAuditLog({
      adminUserId: actor.id,
      action: "AVATAR_UPDATED",
      targetId: employeeId,
      targetType: "admin_user",
      metadata: { cloudinaryId: uploaded.public_id },
      req,
    });

    return updated;
  }

  async listEducation({ id, actor }) {
    const employeeId = assertUuid(id, "employee id");
    assertSelfOrTier(actor, employeeId, "ADMIN");
    await this.ensureEmployee(employeeId);

    return prisma.adminEducation.findMany({
      where: { adminUserId: employeeId },
      select: {
        id: true,
        degreeTitle: true,
        institution: true,
        from: true,
        to: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async createEducation({ id, actor, data, req }) {
    const employeeId = assertUuid(id, "employee id");
    assertSelfOrTier(actor, employeeId, "ADMIN");
    await this.ensureEmployee(employeeId);

    const education = await prisma.adminEducation.create({
      data: { adminUserId: employeeId, ...data },
      select: {
        id: true,
        degreeTitle: true,
        institution: true,
        from: true,
        to: true,
        createdAt: true,
      },
    });

    await this.auditProfileUpdate({
      actor,
      employeeId,
      section: "education_create",
      changes: { educationId: education.id },
      req,
    });

    return education;
  }

  async updateEducation({ id, educationId, actor, data, req }) {
    const employeeId = assertUuid(id, "employee id");
    const eid = assertUuid(educationId, "education id");
    assertSelfOrTier(actor, employeeId, "ADMIN");

    const existing = await prisma.adminEducation.findUnique({ where: { id: eid } });
    if (!existing) throw new ApiError(404, "Education record not found");
    if (existing.adminUserId !== employeeId) {
      throw new ApiError(403, "Education record does not belong to this employee");
    }

    const updated = await prisma.adminEducation.update({
      where: { id: eid },
      data,
      select: {
        id: true,
        degreeTitle: true,
        institution: true,
        from: true,
        to: true,
        createdAt: true,
      },
    });

    await this.auditProfileUpdate({
      actor,
      employeeId,
      section: "education_update",
      changes: { educationId: eid },
      req,
    });

    return updated;
  }

  async deleteEducation({ id, educationId, actor, req }) {
    const employeeId = assertUuid(id, "employee id");
    const eid = assertUuid(educationId, "education id");
    assertSelfOrTier(actor, employeeId, "ADMIN");

    const existing = await prisma.adminEducation.findUnique({ where: { id: eid } });
    if (!existing) throw new ApiError(404, "Education record not found");
    if (existing.adminUserId !== employeeId) {
      throw new ApiError(403, "Education record does not belong to this employee");
    }

    await prisma.adminEducation.delete({ where: { id: eid } });
    await this.auditProfileUpdate({
      actor,
      employeeId,
      section: "education_delete",
      changes: { educationId: eid },
      req,
    });
  }

  async ensureEmployee(employeeId) {
    const employee = await prisma.adminUser.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new ApiError(404, "Employee not found");
    return employee;
  }

  async auditProfileUpdate({ actor, employeeId, section, changes, req }) {
    await createAuditLog({
      adminUserId: actor.id,
      action: "PROFILE_UPDATED",
      targetId: employeeId,
      targetType: "admin_user",
      metadata: { section, changes },
      req,
    });
  }
}

module.exports = new EmployeesService();
