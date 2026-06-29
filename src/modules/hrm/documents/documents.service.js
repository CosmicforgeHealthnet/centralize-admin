const path = require("path");
const { prisma } = require("../../../shared/config/database");
const cloudinary = require("../../../shared/config/cloudinary");
const ApiError = require("../../../shared/utils/ApiError");
const { createAuditLog } = require("../../../shared/middlewares/audit.middleware");
const {
  assertSelfOrTier,
  assertSensitiveTier,
  assertUuid,
  buildMeta,
  destroyCloudinaryResource,
  formatDateOnly,
  normalizeDepartment,
  paginate,
  safeLower,
  uploadBufferToCloudinary,
} = require("../hrm.utils");

const ALLOWED_FORMATS = ["XLS", "XLSX", "PDF", "DOXT", "DOC", "DOCX"];

const EMPLOYEE_PICKER_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  avatarUrl: true,
  status: true,
};

const EMPLOYEE_DETAIL_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  avatarUrl: true,
  status: true,
  personalPhone: true,
  homePhone: true,
  workPhone: true,
  location: true,
};

function mapPickerEmployee(user) {
  return {
    id: user.id,
    employeeCode: null,
    name: user.name,
    email: user.email,
    department: user.department,
    designation: user.position,
    avatarUrl: user.avatarUrl,
    status: user.status,
  };
}

function mapDetailEmployee(user) {
  return {
    id: user.id,
    name: user.name,
    employeeCode: null,
    phone: user.personalPhone || user.homePhone || user.workPhone || null,
    email: user.email,
    position: user.position || null,
    location: user.location || null,
    headOfDepartment: null,
    employmentDate: null,
    avatarUrl: user.avatarUrl || null,
  };
}

function mapDocument(document) {
  return {
    id: document.id,
    title: document.title || document.name,
    name: document.name,
    type: document.type,
    url: document.url,
    uploadedBy: document.uploadedBy,
    uploadedAt: document.uploadedAt,
    expiryDate: formatDateOnly(document.expiryDate),
  };
}

function documentWhereFromQuery(query = {}) {
  const where = {};
  const search = String(query.search || "").trim();
  const filterBy = String(query.filterBy || "").trim().toLowerCase();

  if (!search) return where;

  if (filterBy === "type") {
    where.type = { equals: search.toLowerCase(), mode: "insensitive" };
  } else if (filterBy === "date") {
    const date = new Date(search);
    if (Number.isNaN(date.getTime())) throw new ApiError(400, "Invalid date filter.");
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + 1);
    where.uploadedAt = { gte: date, lt: next };
  } else {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
      { type: { contains: search, mode: "insensitive" } },
    ];
  }

  return where;
}

function pickerWhereFromQuery(query = {}) {
  const where = {};
  const search = String(query.search || "").trim();
  const filterBy = String(query.filterBy || "").trim().toLowerCase();
  if (!search) return where;

  if (filterBy === "department") {
    where.department = normalizeDepartment(search);
  } else if (filterBy === "designation") {
    where.position = { contains: search, mode: "insensitive" };
  } else {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { position: { contains: search, mode: "insensitive" } },
    ];
  }

  return where;
}

class DocumentsService {
  async getEmployees(query = {}) {
    const { page, limit, skip } = paginate(query, 20, 100);
    const where = pickerWhereFromQuery(query);

    const [total, employees] = await Promise.all([
      prisma.adminUser.count({ where }),
      prisma.adminUser.findMany({
        where,
        select: EMPLOYEE_PICKER_SELECT,
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: employees.map(mapPickerEmployee),
      meta: buildMeta(total, page, limit),
    };
  }

  async getEmployeeDocuments({ employeeId, actor, query = {} }) {
    const id = assertUuid(employeeId, "employee id");
    assertSelfOrTier(actor, id, "ADMIN");

    const employee = await prisma.adminUser.findUnique({
      where: { id },
      select: EMPLOYEE_DETAIL_SELECT,
    });
    if (!employee) throw new ApiError(404, "Employee not found");

    const where = { adminUserId: id, ...documentWhereFromQuery(query) };
    const documents = await prisma.adminDocument.findMany({
      where,
      orderBy: { uploadedAt: "desc" },
    });

    return {
      employee: mapDetailEmployee(employee),
      documents: documents.map(mapDocument),
    };
  }

  async uploadDocument({ employeeId, actor, file, data, req }) {
    const id = assertUuid(employeeId, "employee id");
    assertSensitiveTier(actor);
    if (!file) throw new ApiError(400, "No file uploaded. Use field 'file'.");

    const format = data.format.toUpperCase();
    if (!ALLOWED_FORMATS.includes(format)) throw new ApiError(400, "Unsupported file type");

    const extension = path.extname(file.originalname || "").replace(".", "").toUpperCase();
    if (extension && !ALLOWED_FORMATS.includes(extension)) {
      throw new ApiError(400, "Unsupported file extension");
    }

    const employee = await prisma.adminUser.findUnique({ where: { id }, select: { id: true } });
    if (!employee) throw new ApiError(404, "Employee not found");

    const uploaded = await uploadBufferToCloudinary(file, {
      folder: "hrm/documents",
      public_id: `document-${id}-${Date.now()}`,
      resource_type: "auto",
      use_filename: true,
    });

    let expiryDate = null;
    if (data.expiry) {
      const parsed = new Date(data.expiry);
      if (!Number.isNaN(parsed.getTime())) expiryDate = parsed;
    }

    const document = await prisma.adminDocument.create({
      data: {
        adminUserId: id,
        name: file.originalname || data.title,
        title: data.title,
        type: safeLower(format),
        url: uploaded.secure_url,
        cloudinaryId: uploaded.public_id,
        uploadedBy: actor.id,
        expiryDate,
      },
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: "DOCUMENT_UPLOADED",
      targetId: document.id,
      targetType: "admin_document",
      metadata: { employeeId: id, title: data.title, type: format },
      req,
    });

    return mapDocument(document);
  }

  async deleteDocument({ employeeId, documentId, actor, req }) {
    const id = assertUuid(employeeId, "employee id");
    const docId = assertUuid(documentId, "document id");
    assertSensitiveTier(actor);

    const document = await prisma.adminDocument.findUnique({ where: { id: docId } });
    if (!document) throw new ApiError(404, "Document not found");
    if (document.adminUserId !== id) {
      throw new ApiError(403, "Document does not belong to this employee");
    }

    await destroyCloudinaryResource(document.cloudinaryId, "auto");
    await prisma.adminDocument.delete({ where: { id: docId } });

    await createAuditLog({
      adminUserId: actor.id,
      action: "DOCUMENT_DELETED",
      targetId: docId,
      targetType: "admin_document",
      metadata: { employeeId: id, title: document.title || document.name },
      req,
    });
  }

  async getDownload({ employeeId, documentId, actor }) {
    const id = assertUuid(employeeId, "employee id");
    const docId = assertUuid(documentId, "document id");
    assertSelfOrTier(actor, id, "ADMIN");

    const document = await prisma.adminDocument.findUnique({ where: { id: docId } });
    if (!document) throw new ApiError(404, "Document not found");
    if (document.adminUserId !== id) {
      throw new ApiError(403, "Document does not belong to this employee");
    }

    const url = document.cloudinaryId
      ? cloudinary.url(document.cloudinaryId, { secure: true, resource_type: "auto", flags: "attachment" })
      : document.url;

    return {
      url,
      name: document.title || document.name,
      type: document.type,
    };
  }
}

module.exports = new DocumentsService();
