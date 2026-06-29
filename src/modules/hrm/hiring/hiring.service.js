const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const { createAuditLog } = require("../../../shared/middlewares/audit.middleware");
const {
  assertUuid,
  buildMeta,
  formatDateOnly,
  normalizeDepartment,
  paginate,
  percentageChange,
  unsupportedEndpoint,
} = require("../hrm.utils");

const VACANCY_STATUSES = ["OPEN", "IN_REVIEW", "CLOSED"];
const APPLICANT_STAGES = ["SCREENING", "INTERVIEW", "HIRED", "REJECTED"];

function assertHiringSchemaSupported() {
  if (!prisma.jobVacancy || !prisma.jobApplicant) {
    unsupportedEndpoint("Hiring", ["JobVacancy", "JobApplicant"]);
  }
}

function normalizeVacancyStatus(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const upper = String(value).trim().toUpperCase().replace(/[-\s]+/g, "_");
  if (!VACANCY_STATUSES.includes(upper)) {
    throw new ApiError(400, "Invalid status. Use OPEN, IN_REVIEW, or CLOSED.");
  }
  return upper;
}

function normalizeApplicantStage(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const upper = String(value).trim().toUpperCase();
  if (!APPLICANT_STAGES.includes(upper)) {
    throw new ApiError(400, "Invalid stage. Use SCREENING, INTERVIEW, HIRED, or REJECTED.");
  }
  return upper;
}

function parseOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(400, `Invalid ${fieldName}. Use a valid date string.`);
  }
  return d;
}

function mapVacancyRow(vacancy, applicantsCount = 0) {
  return {
    id: vacancy.id,
    title: vacancy.title,
    department: vacancy.department || null,
    category: vacancy.category || null,
    location: vacancy.location || null,
    numberOfOpening: vacancy.numberOfOpening,
    applicantsCount,
    status: vacancy.status,
    createdAt: formatDateOnly(vacancy.createdAt),
  };
}

function mapApplicantRow(applicant) {
  return {
    id: applicant.id,
    fullName: applicant.fullName,
    email: applicant.email || null,
    phone: applicant.phone || null,
    country: applicant.country || null,
    stage: applicant.stage,
    via: applicant.via || null,
    applicationDate: formatDateOnly(applicant.applicationDate),
  };
}

function buildVacancyWhere(query = {}) {
  const where = {};

  const status = normalizeVacancyStatus(query.status);
  if (status) where.status = status;

  const search = String(query.search || "").trim();
  const filterBy = String(query.filterBy || "").trim().toLowerCase();

  if (search) {
    if (filterBy === "department") {
      const dept = normalizeDepartment(search);
      if (dept) where.department = dept;
    } else if (filterBy === "category") {
      where.category = { contains: search, mode: "insensitive" };
    } else {
      where.title = { contains: search, mode: "insensitive" };
    }
  }

  return where;
}

function buildApplicantWhere(vacancyId, query = {}) {
  const where = { vacancyId };

  const search = String(query.search || "").trim();
  if (search) {
    where.OR = [
      { fullName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }

  const rawStage = String(query.stage || "").trim();
  if (rawStage && rawStage.toLowerCase() !== "all") {
    where.stage = normalizeApplicantStage(rawStage);
  }

  return where;
}

async function ensureVacancy(id) {
  const vacancyId = assertUuid(id, "vacancy id");
  const vacancy = await prisma.jobVacancy.findUnique({ where: { id: vacancyId } });
  if (!vacancy) throw new ApiError(404, "Vacancy not found");
  return vacancy;
}

async function ensureApplicant(id) {
  const applicantId = assertUuid(id, "applicant id");
  const applicant = await prisma.jobApplicant.findUnique({
    where: { id: applicantId },
    include: {
      vacancy: true,
      attachments: true,
    },
  });
  if (!applicant) throw new ApiError(404, "Applicant not found");
  return applicant;
}

class HiringService {
  async getStats() {
    assertHiringSchemaSupported();

    const now = new Date();
    const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

    const [
      numberOfOpenings,
      applicationsReceived,
      prevOpenings,
      prevApplications,
    ] = await Promise.all([
      prisma.jobVacancy.count({ where: { status: "OPEN" } }),
      prisma.jobApplicant.count(),
      prisma.jobVacancy.count({ where: { status: "OPEN", createdAt: { lt: thisMonthStart } } }),
      prisma.jobApplicant.count({ where: { createdAt: { lt: thisMonthStart } } }),
    ]);

    return {
      numberOfOpenings,
      applicationsReceived,
      changes: {
        openingsChange: percentageChange(numberOfOpenings, prevOpenings),
        applicationsChange: percentageChange(applicationsReceived, prevApplications),
      },
    };
  }

  async listVacancies(query = {}) {
    assertHiringSchemaSupported();

    const { page, limit, skip } = paginate(query, 10, 100);
    const where = buildVacancyWhere(query);

    const [total, vacancies] = await Promise.all([
      prisma.jobVacancy.count({ where }),
      prisma.jobVacancy.findMany({
        where,
        include: { _count: { select: { applicants: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: vacancies.map((v) => mapVacancyRow(v, v._count.applicants)),
      meta: buildMeta(total, page, limit),
    };
  }

  async createVacancy({ data, actor, req }) {
    assertHiringSchemaSupported();

    const vacancy = await prisma.jobVacancy.create({
      data: {
        title: data.title,
        department: data.department || null,
        category: data.category || null,
        location: data.location || null,
        numberOfOpening: Number(data.numberOfOpening) || 1,
        experienceLevel: data.experienceLevel || null,
        salaryRange: data.salaryRange || null,
        benefitsAndBonus: data.benefitsAndBonus || null,
        jobDescription: data.jobDescription || null,
        responsibilities: data.responsibilities || null,
        requirements: data.requirements || null,
        hiringStages: data.hiringStages || null,
        assignedRecruiter: data.assignedRecruiter || null,
        deadline: parseOptionalDate(data.deadline, "deadline"),
        status: normalizeVacancyStatus(data.status) || "OPEN",
      },
      select: { id: true },
    });

    await createAuditLog({
      adminUserId: actor?.id,
      action: "HRM_VACANCY_CREATED",
      targetId: vacancy.id,
      targetType: "job_vacancy",
      metadata: { title: data.title },
      req,
    });

    return { id: vacancy.id };
  }

  async getVacancy(id) {
    assertHiringSchemaSupported();

    const vacancyId = assertUuid(id, "vacancy id");
    const vacancy = await prisma.jobVacancy.findUnique({
      where: { id: vacancyId },
      include: { _count: { select: { applicants: true } } },
    });
    if (!vacancy) throw new ApiError(404, "Vacancy not found");

    return {
      id: vacancy.id,
      title: vacancy.title,
      department: vacancy.department || null,
      category: vacancy.category || null,
      location: vacancy.location || null,
      numberOfOpening: vacancy.numberOfOpening,
      experienceLevel: vacancy.experienceLevel || null,
      salaryRange: vacancy.salaryRange || null,
      benefitsAndBonus: vacancy.benefitsAndBonus || null,
      jobDescription: vacancy.jobDescription || null,
      responsibilities: vacancy.responsibilities || null,
      requirements: vacancy.requirements || null,
      hiringStages: vacancy.hiringStages || null,
      assignedRecruiter: vacancy.assignedRecruiter || null,
      deadline: formatDateOnly(vacancy.deadline),
      status: vacancy.status,
      applicantsCount: vacancy._count.applicants,
      createdAt: formatDateOnly(vacancy.createdAt),
      updatedAt: formatDateOnly(vacancy.updatedAt),
    };
  }

  async updateVacancy({ id, data, actor, req }) {
    assertHiringSchemaSupported();

    await ensureVacancy(id);
    const vacancyId = assertUuid(id, "vacancy id");

    const update = {};
    if (data.title !== undefined) update.title = data.title;
    if (data.department !== undefined) update.department = data.department || null;
    if (data.category !== undefined) update.category = data.category || null;
    if (data.location !== undefined) update.location = data.location || null;
    if (data.numberOfOpening !== undefined) update.numberOfOpening = Number(data.numberOfOpening) || 1;
    if (data.experienceLevel !== undefined) update.experienceLevel = data.experienceLevel || null;
    if (data.salaryRange !== undefined) update.salaryRange = data.salaryRange || null;
    if (data.benefitsAndBonus !== undefined) update.benefitsAndBonus = data.benefitsAndBonus || null;
    if (data.jobDescription !== undefined) update.jobDescription = data.jobDescription || null;
    if (data.responsibilities !== undefined) update.responsibilities = data.responsibilities || null;
    if (data.requirements !== undefined) update.requirements = data.requirements || null;
    if (data.hiringStages !== undefined) update.hiringStages = data.hiringStages || null;
    if (data.assignedRecruiter !== undefined) update.assignedRecruiter = data.assignedRecruiter || null;
    if (data.deadline !== undefined) update.deadline = parseOptionalDate(data.deadline, "deadline");
    if (data.status !== undefined) update.status = normalizeVacancyStatus(data.status);

    if (!Object.keys(update).length) throw new ApiError(400, "No valid fields provided");

    await prisma.jobVacancy.update({ where: { id: vacancyId }, data: update });

    await createAuditLog({
      adminUserId: actor?.id,
      action: "HRM_VACANCY_UPDATED",
      targetId: vacancyId,
      targetType: "job_vacancy",
      metadata: { updatedFields: Object.keys(update) },
      req,
    });

    return {};
  }

  async updateVacancyStatus({ id, status, actor, req }) {
    assertHiringSchemaSupported();

    const normalized = normalizeVacancyStatus(status);
    if (!normalized) throw new ApiError(400, "status is required.");

    await ensureVacancy(id);
    const vacancyId = assertUuid(id, "vacancy id");

    await prisma.jobVacancy.update({
      where: { id: vacancyId },
      data: { status: normalized },
    });

    await createAuditLog({
      adminUserId: actor?.id,
      action: "HRM_VACANCY_STATUS_UPDATED",
      targetId: vacancyId,
      targetType: "job_vacancy",
      metadata: { status: normalized },
      req,
    });

    return { status: normalized };
  }

  async deleteVacancy({ id, actor, req }) {
    assertHiringSchemaSupported();

    await ensureVacancy(id);
    const vacancyId = assertUuid(id, "vacancy id");

    await prisma.jobVacancy.delete({ where: { id: vacancyId } });

    await createAuditLog({
      adminUserId: actor?.id,
      action: "HRM_VACANCY_DELETED",
      targetId: vacancyId,
      targetType: "job_vacancy",
      metadata: {},
      req,
    });

    return {};
  }

  async listApplicants(vacancyId, query = {}) {
    assertHiringSchemaSupported();

    const id = assertUuid(vacancyId, "vacancy id");
    const vacancy = await prisma.jobVacancy.findUnique({ where: { id }, select: { id: true } });
    if (!vacancy) throw new ApiError(404, "Vacancy not found");

    const { page, limit, skip } = paginate(query, 10, 100);
    const where = buildApplicantWhere(id, query);

    const [total, applicants] = await Promise.all([
      prisma.jobApplicant.count({ where }),
      prisma.jobApplicant.findMany({
        where,
        orderBy: { applicationDate: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: applicants.map(mapApplicantRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async getApplicant(id) {
    assertHiringSchemaSupported();

    const applicant = await ensureApplicant(id);
    const vacancy = applicant.vacancy || {};

    return {
      id: applicant.id,
      fullName: applicant.fullName,
      email: applicant.email || null,
      phone: applicant.phone || null,
      country: applicant.country || null,
      stage: applicant.stage,
      via: applicant.via || null,
      applicationDate: formatDateOnly(applicant.applicationDate),
      coverLetter: applicant.coverLetter || null,
      vacancy: {
        id: vacancy.id || null,
        title: vacancy.title || null,
        category: vacancy.category || null,
        location: vacancy.location || null,
        department: vacancy.department || null,
      },
      attachments: (applicant.attachments || []).map((a) => ({
        id: a.id,
        url: a.url,
        name: a.name || null,
        type: a.type || null,
      })),
    };
  }

  async updateApplicantStage({ id, stage, actor, req }) {
    assertHiringSchemaSupported();

    const normalized = normalizeApplicantStage(stage);
    if (!normalized) throw new ApiError(400, "stage is required.");

    const applicantId = assertUuid(id, "applicant id");
    const existing = await prisma.jobApplicant.findUnique({
      where: { id: applicantId },
      select: { id: true },
    });
    if (!existing) throw new ApiError(404, "Applicant not found");

    await prisma.jobApplicant.update({
      where: { id: applicantId },
      data: { stage: normalized },
    });

    await createAuditLog({
      adminUserId: actor?.id,
      action: "HRM_APPLICANT_STAGE_UPDATED",
      targetId: applicantId,
      targetType: "job_applicant",
      metadata: { stage: normalized },
      req,
    });

    return { stage: normalized };
  }
}

module.exports = new HiringService();
