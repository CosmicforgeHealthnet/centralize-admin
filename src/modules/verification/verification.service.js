const { mainPrisma } = require("../../shared/config/mainDatabase");
const { prisma } = require("../../shared/config/database");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const ApiError = require("../../shared/utils/ApiError");
const {
  generateTempPassword,
  hashPassword,
} = require("../../shared/utils/password.util");
const { sendLabApprovalEmail } = require("../../shared/utils/email.util");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a risk indicator from the verification request's confidence score
 * and current status. The main DB has no dedicated riskIndicator column so
 * we compute it here and send it to the frontend.
 *
 *  confidenceScore >= 70  → Low
 *  confidenceScore >= 40  → Medium
 *  confidenceScore <  40  → High
 *
 * If the request was rejected / expired we always treat it as High risk.
 */
function deriveRiskIndicator(req) {
  if (["rejected", "expired"].includes(req.status)) return "High";
  const score = req.confidenceScore ?? 0;
  if (score >= 70) return "Low";
  if (score >= 40) return "Medium";
  return "High";
}

/**
 * Map main-DB verification_requests status values → frontend display status.
 *
 * Main DB statuses: pending | in_progress | pending_documents |
 *                   api_verification | manual_review | approved |
 *                   rejected | expired
 *
 * Frontend expects: Pending | Approved | Failed
 */
function mapStatus(status) {
  if (status === "approved") return "Approved";
  if (["rejected", "expired"].includes(status)) return "Failed";
  return "Pending";
}

/**
 * Shape a raw verification_requests row (with its relations) into the
 * object the frontend table and detail pages expect.
 */
function shapeListItem(vr) {
  const user = vr.users_verification_requests_doctorIdTousers;

  // Get specialty from doctor's professional_licenses
  let specialty = null;
  if (user?.doctor_profiles?.professional_licenses?.areasOfSpecialization) {
    const specialties =
      user.doctor_profiles.professional_licenses.areasOfSpecialization;
    specialty = specialties.length > 0 ? specialties[0] : null;
  }

  return {
    id: vr.id,
    user: user?.fullName ?? "Unknown",
    role: "Doctors",
    verificationType: "License",
    licenseId: vr.licenseNumber,
    status: mapStatus(vr.status),
    rawStatus: vr.status,
    submittedDate: vr.submittedAt
      ? new Date(vr.submittedAt).toLocaleDateString("en-GB")
      : null,
    riskIndicator: deriveRiskIndicator(vr),
    confidenceScore: vr.confidenceScore,
    countryCode: vr.countryCode,
    assignedReviewerId: vr.assignedReviewerId,
    profileImageUrl: user?.profileImageUrl ?? null,
    specialty: specialty,
  };
}
// ─── Service ──────────────────────────────────────────────────────────────────

class VerificationService {
  // ── LIST ────────────────────────────────────────────────────────────────────

  /**
   * GET /api/verification
   * Returns paginated verification requests with optional filters.
   *
   * Query params:
   *   page, limit, status, startDate, endDate, search, riskIndicator
   *   countryCode, assignedReviewerId
   */
  async getAll({
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
    search,
    riskIndicator,
    countryCode,
    assignedReviewerId,
  }) {
    const where = {};

    // Map frontend status → one or more raw DB statuses
    if (status && status !== "All") {
      if (status === "Approved") {
        where.status = "approved";
      } else if (status === "Failed") {
        where.status = { in: ["rejected", "expired"] };
      } else {
        // "Pending" covers everything in-flight
        where.status = {
          in: [
            "pending",
            "in_progress",
            "pending_documents",
            "api_verification",
            "manual_review",
          ],
        };
      }
    }

    if (countryCode) where.countryCode = countryCode;
    if (assignedReviewerId) where.assignedReviewerId = assignedReviewerId;

    if (startDate || endDate) {
      where.submittedAt = {};
      if (startDate) where.submittedAt.gte = new Date(startDate);
      if (endDate) {
        // Include the full end day
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.submittedAt.lte = end;
      }
    }

    if (search) {
      where.OR = [
        { licenseNumber: { contains: search, mode: "insensitive" } },
        {
          users_verification_requests_doctorIdTousers: {
            fullName: { contains: search, mode: "insensitive" },
          },
        },
        {
          users_verification_requests_doctorIdTousers: {
            email: { contains: search, mode: "insensitive" },
          },
        },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [total, rows] = await Promise.all([
      mainPrisma.verification_requests.count({ where }),
      mainPrisma.verification_requests.findMany({
        where,
        include: {
          users_verification_requests_doctorIdTousers: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phoneNumber: true,
              profileImageUrl: true,
              createdAt: true,
              doctor_profiles: {
                select: {
                  professional_licenses: {
                    select: {
                      areasOfSpecialization: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { submittedAt: "desc" },
        skip,
        take: Number(limit),
      }),
    ]);

    // Stats block (always computed on the full, unfiltered dataset)
    const [totalAll, totalApproved, totalPending] = await Promise.all([
      mainPrisma.verification_requests.count(),
      mainPrisma.verification_requests.count({ where: { status: "approved" } }),
      mainPrisma.verification_requests.count({
        where: {
          status: {
            in: [
              "pending",
              "in_progress",
              "pending_documents",
              "api_verification",
              "manual_review",
            ],
          },
        },
      }),
    ]);

    const approvalRate =
      totalAll > 0 ? ((totalApproved / totalAll) * 100).toFixed(1) : "0";

    return {
      stats: {
        totalRequests: totalAll,
        approvalRate: `${approvalRate}%`,
        pendingRequests: totalPending,
      },
      requests: rows.map(shapeListItem),
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
        totalItems: total,
        itemsPerPage: Number(limit),
      },
    };
  }

  // ── DETAIL ──────────────────────────────────────────────────────────────────

  /**
   * GET /api/verification/:id
   * Full detail for the verification detail page (Overview, Documents, History tabs).
   */
  async getById(id) {
    const vr = await mainPrisma.verification_requests.findUnique({
      where: { id },
      include: {
        // Doctor user
        users_verification_requests_doctorIdTousers: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phoneNumber: true,
            profileImageUrl: true,
            createdAt: true,
            role: true,
            status: true,
            doctor_profiles: {
              select: {
                gender: true,
                dateOfBirth: true,
                nationality: true,
                contactNumber: true,
                residentialAddress: true,
                professional_licenses: {
                  select: {
                    medicalLicenseNumber: true,
                    countryOfLicense: true,
                    licenseAuthority: true,
                    licenseExpiryDate: true,
                    licenseDocument: true,
                    yearsOfExperience: true,
                    areasOfSpecialization: true,
                    subspecialty: true,
                    medicalInstitution: true,
                  },
                },
                professional_certificates: {
                  select: {
                    institution: true,
                    degree: true,
                    fieldOfStudy: true,
                    startYear: true,
                    endYear: true,
                    certificateName: true,
                    issuingBody: true,
                    issueDate: true,
                    expiryDate: true,
                    certificateDocument: true,
                  },
                },
                clinical_practices: {
                  select: {
                    clinicName: true,
                    location: true,
                    daysAvailableFrom: true,
                    daysAvailableTo: true,
                    timeAvailableFrom: true,
                    timeAvailableTo: true,
                    consultationFee: true,
                  },
                },
              },
            },
          },
        },
        // Uploaded verification documents
        verification_documents: {
          orderBy: { uploadedAt: "desc" },
        },
        // Status history (timeline)
        verification_status_history: {
          orderBy: { changedAt: "asc" },
          include: {
            users: {
              select: { id: true, fullName: true },
            },
          },
        },
        // Review queue entry
        verification_review_queue: true,
        // Assigned reviewer
        users_verification_requests_assignedReviewerIdTousers: {
          select: { id: true, fullName: true, email: true },
        },
      },
    });

    if (!vr) throw new ApiError(404, "Verification request not found");

    const doctor = vr.users_verification_requests_doctorIdTousers;
    const profile = doctor?.doctor_profiles;
    const license = profile?.professional_licenses;
    const cert = profile?.professional_certificates;
    const clinic = profile?.clinical_practices;
    const queue = vr.verification_review_queue;

    return {
      id: vr.id,
      status: mapStatus(vr.status),
      rawStatus: vr.status,
      riskIndicator: deriveRiskIndicator(vr),
      confidenceScore: vr.confidenceScore,
      method: vr.method,
      tier: vr.tier,
      submittedAt: vr.submittedAt,
      approvedAt: vr.approvedAt,
      rejectedAt: vr.rejectedAt,
      expiresAt: vr.expiresAt,
      reviewNotes: vr.reviewNotes,
      rejectionReason: vr.rejectionReason,

      // Contact details (left panel)
      contact: {
        fullName: doctor?.fullName ?? "",
        phone: doctor?.phoneNumber ?? profile?.contactNumber ?? "",
        email: doctor?.email ?? "",
        location: profile?.residentialAddress ?? "",
        registrationDate: doctor?.createdAt
          ? new Date(doctor.createdAt).toLocaleDateString("en-GB")
          : "",
        profileImageUrl: doctor?.profileImageUrl ?? null,
      },

      // License info (overview tab right column)
      license: {
        licenseNumber: vr.licenseNumber,
        licenseType: vr.licenseType ?? license?.medicalLicenseNumber ?? "",
        issuingAuthority:
          vr.issuingAuthority ?? license?.licenseAuthority ?? "",
        countryCode: vr.countryCode,
        issueDate: vr.issueDate,
        expiryDate: vr.expiryDate ?? license?.licenseExpiryDate ?? null,
        yearsOfExperience: license?.yearsOfExperience ?? null,
        areasOfSpecialization: license?.areasOfSpecialization ?? [],
        subspecialty: license?.subspecialty ?? "",
        medicalInstitution: license?.medicalInstitution ?? "",
        licenseDocumentUrl: license?.licenseDocument ?? null,
      },

      // Education / certificates
      education: cert
        ? {
            institution: cert.institution,
            degree: cert.degree,
            fieldOfStudy: cert.fieldOfStudy,
            startYear: cert.startYear,
            endYear: cert.endYear,
            certificateName: cert.certificateName,
            issuingBody: cert.issuingBody,
            issueDate: cert.issueDate,
            expiryDate: cert.expiryDate,
            certificateDocumentUrl: cert.certificateDocument,
          }
        : null,

      // Clinical practice
      practice: clinic
        ? {
            clinicName: clinic.clinicName,
            location: clinic.location,
            daysAvailableFrom: clinic.daysAvailableFrom,
            daysAvailableTo: clinic.daysAvailableTo,
            timeAvailableFrom: clinic.timeAvailableFrom,
            timeAvailableTo: clinic.timeAvailableTo,
            consultationFee: clinic.consultationFee,
          }
        : null,

      // Documents tab
      documents: vr.verification_documents.map((doc) => ({
        id: doc.id,
        name: doc.originalFileName,
        documentType: doc.documentType,
        status: doc.status,
        filePath: doc.filePath,
        fileSize: doc.fileSize,
        mimeType: doc.mimeType,
        uploadedAt: doc.uploadedAt,
        ocrConfidence: doc.ocrConfidence,
        rejectionReason: doc.rejectionReason,
      })),

      // History tab
      history: vr.verification_status_history.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus ? mapStatus(h.fromStatus) : null,
        toStatus: mapStatus(h.toStatus),
        rawToStatus: h.toStatus,
        changedBy: h.users?.fullName ?? "System",
        changeReason: h.changeReason,
        automatedChange: h.automatedChange,
        changedAt: h.changedAt,
      })),

      // Queue / SLA info
      queue: queue
        ? {
            priority: queue.priority,
            slaTarget: queue.slaTarget,
            slaBreached: queue.slaBreached,
            escalated: queue.escalated,
            escalationReason: queue.escalationReason,
            addedToQueueAt: queue.addedToQueueAt,
          }
        : null,

      // Assigned reviewer
      assignedReviewer:
        vr.users_verification_requests_assignedReviewerIdTousers ?? null,
    };
  }

  // ── APPROVE ─────────────────────────────────────────────────────────────────

  /**
   * PATCH /api/verification/:id/approve
   * Approve a verification request and record status history.
   */
  async approve({ id, adminUserId, reviewNotes, req }) {
    const vr = await mainPrisma.verification_requests.findUnique({
      where: { id },
    });
    if (!vr) throw new ApiError(404, "Verification request not found");
    if (vr.status === "approved") {
      throw new ApiError(400, "Verification request is already approved");
    }

    const now = new Date();
    const previousStatus = vr.status;

    // Find the main-app user linked to this admin so we can record who approved
    const adminUser = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { mainAppUserId: true, name: true },
    });

    await mainPrisma.$transaction(async (tx) => {
      // 1. Update the verification request
      await tx.verification_requests.update({
        where: { id },
        data: {
          status: "approved",
          approvedAt: now,
          reviewNotes: reviewNotes ?? vr.reviewNotes,
          reviewCompletedAt: now,
          assignedReviewerId: adminUser?.mainAppUserId ?? vr.assignedReviewerId,
          updatedBy: adminUser?.mainAppUserId ?? null,
        },
      });

      // 2. Record status history in the main DB
      await tx.verification_status_history.create({
        data: {
          verificationRequestId: id,
          fromStatus: previousStatus,
          toStatus: "approved",
          changedBy: adminUser?.mainAppUserId ?? vr.doctorId, // fallback to doctor id
          changeReason: reviewNotes ?? "Approved by admin",
          automatedChange: false,
          changedAt: now,
        },
      });

      // 3. Mark queue as completed if it exists
      const queue = await tx.verification_review_queue.findUnique({
        where: { verificationRequestId: id },
      });
      if (queue) {
        await tx.verification_review_queue.update({
          where: { verificationRequestId: id },
          data: { completedAt: now },
        });
      }
    });

    // 4. Audit log in admin DB
    await createAuditLog({
      adminUserId,
      action: "USER_UPDATED",
      targetId: id,
      targetType: "verification_request",
      metadata: {
        action: "approved",
        verificationRequestId: id,
        doctorId: vr.doctorId,
        previousStatus,
        reviewNotes,
      },
      req,
    });

    return { id, status: "Approved" };
  }

  // ── REJECT ──────────────────────────────────────────────────────────────────

  /**
   * PATCH /api/verification/:id/reject
   * Reject a verification request and record status history.
   */
  async reject({ id, adminUserId, rejectionReason, reviewNotes, req }) {
    if (!rejectionReason) {
      throw new ApiError(400, "Rejection reason is required");
    }

    const vr = await mainPrisma.verification_requests.findUnique({
      where: { id },
    });
    if (!vr) throw new ApiError(404, "Verification request not found");
    if (vr.status === "rejected") {
      throw new ApiError(400, "Verification request is already rejected");
    }

    const now = new Date();
    const previousStatus = vr.status;

    const adminUser = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { mainAppUserId: true, name: true },
    });

    await mainPrisma.$transaction(async (tx) => {
      await tx.verification_requests.update({
        where: { id },
        data: {
          status: "rejected",
          rejectedAt: now,
          rejectionReason,
          reviewNotes: reviewNotes ?? vr.reviewNotes,
          reviewCompletedAt: now,
          assignedReviewerId: adminUser?.mainAppUserId ?? vr.assignedReviewerId,
          updatedBy: adminUser?.mainAppUserId ?? null,
        },
      });

      await tx.verification_status_history.create({
        data: {
          verificationRequestId: id,
          fromStatus: previousStatus,
          toStatus: "rejected",
          changedBy: adminUser?.mainAppUserId ?? vr.doctorId,
          changeReason: rejectionReason,
          automatedChange: false,
          changedAt: now,
        },
      });

      const queue = await tx.verification_review_queue.findUnique({
        where: { verificationRequestId: id },
      });
      if (queue) {
        await tx.verification_review_queue.update({
          where: { verificationRequestId: id },
          data: { completedAt: now },
        });
      }
    });

    await createAuditLog({
      adminUserId,
      action: "USER_UPDATED",
      targetId: id,
      targetType: "verification_request",
      metadata: {
        action: "rejected",
        verificationRequestId: id,
        doctorId: vr.doctorId,
        previousStatus,
        rejectionReason,
        reviewNotes,
      },
      req,
    });

    return { id, status: "Failed" };
  }

  // ── ASSIGN REVIEWER ─────────────────────────────────────────────────────────

  /**
   * PATCH /api/verification/:id/assign
   * Assign a verification request to an admin reviewer.
   * Body: { reviewerId } — must be a mainAppUserId
   */
  async assignReviewer({ id, reviewerId, adminUserId, req }) {
    const vr = await mainPrisma.verification_requests.findUnique({
      where: { id },
    });
    if (!vr) throw new ApiError(404, "Verification request not found");

    // Validate reviewerId exists in main DB
    const reviewer = await mainPrisma.users.findUnique({
      where: { id: reviewerId },
      select: { id: true, fullName: true },
    });
    if (!reviewer)
      throw new ApiError(404, "Reviewer not found in main database");

    const now = new Date();

    await mainPrisma.$transaction(async (tx) => {
      await tx.verification_requests.update({
        where: { id },
        data: {
          assignedReviewerId: reviewerId,
          reviewStartedAt: now,
          status: vr.status === "pending" ? "manual_review" : vr.status,
        },
      });

      // Upsert queue entry
      await tx.verification_review_queue.upsert({
        where: { verificationRequestId: id },
        update: { assignedTo: reviewerId, assignedAt: now },
        create: {
          verificationRequestId: id,
          assignedTo: reviewerId,
          assignedAt: now,
          priority: "normal",
          addedToQueueAt: now,
        },
      });
    });

    await createAuditLog({
      adminUserId,
      action: "TICKET_ASSIGNED",
      targetId: id,
      targetType: "verification_request",
      metadata: { reviewerId, reviewerName: reviewer.fullName },
      req,
    });

    return { id, assignedReviewerId: reviewerId };
  }

  // ── PHARMACY VERIFICATIONS ───────────────────────────────────────────────────

  /**
   * GET /api/verification/pharmacies
   * Paginated list of pharmacy verification requests.
   */
  async getPharmacyVerifications({
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
    search,
  }) {
    const where = {};

    if (status && status !== "All") {
      if (status === "Approved") {
        where.status = "approved";
      } else if (status === "Failed") {
        where.status = { in: ["rejected"] };
      } else {
        where.status = { in: ["pending", "in_progress", "requires_changes"] };
      }
    }

    if (startDate || endDate) {
      where.submittedAt = {};
      if (startDate) where.submittedAt.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.submittedAt.lte = end;
      }
    }

    if (search) {
      where.pharmacy_profiles = {
        OR: [
          { pharmacyName: { contains: search, mode: "insensitive" } },
          { registrationNumber: { contains: search, mode: "insensitive" } },
        ],
      };
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [total, rows] = await Promise.all([
      mainPrisma.pharmacy_verification_requests.count({ where }),
      mainPrisma.pharmacy_verification_requests.findMany({
        where,
        include: {
          pharmacy_profiles: {
            select: {
              id: true,
              pharmacyName: true,
              registrationNumber: true,
              licenseNumber: true,
              address: true,
              phone: true,
              email: true,
              verificationStatus: true,
              users: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  profileImageUrl: true,
                  createdAt: true,
                },
              },
            },
          },
        },
        orderBy: { submittedAt: "desc" },
        skip,
        take: Number(limit),
      }),
    ]);

    const shaped = rows.map((pvr) => {
      const pharmacy = pvr.pharmacy_profiles;
      const owner = pharmacy?.users;

      let mappedStatus = "Pending";
      if (pvr.status === "approved") mappedStatus = "Approved";
      else if (pvr.status === "rejected") mappedStatus = "Failed";

      return {
        id: pvr.id,
        user: pharmacy?.pharmacyName ?? owner?.fullName ?? "Unknown",
        role: "Pharmacies",
        verificationType: "Business",
        licenseId:
          pharmacy?.licenseNumber ?? pharmacy?.registrationNumber ?? "",
        status: mappedStatus,
        rawStatus: pvr.status,
        submittedDate: pvr.submittedAt
          ? new Date(pvr.submittedAt).toLocaleDateString("en-GB")
          : null,
        // Pharmacy verifications have no confidenceScore — default Medium
        riskIndicator:
          pvr.status === "rejected"
            ? "High"
            : pvr.status === "approved"
              ? "Low"
              : "Medium",
        priority: pvr.priority,
      };
    });

    return {
      requests: shaped,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
        totalItems: total,
        itemsPerPage: Number(limit),
      },
    };
  }

  // ── PHARMACY DETAIL ──────────────────────────────────────────────────────────

  /**
   * GET /api/verification/pharmacies/:id
   */
  async getPharmacyVerificationById(id) {
    const pvr = await mainPrisma.pharmacy_verification_requests.findUnique({
      where: { id },
      include: {
        pharmacy_profiles: {
          include: {
            users: {
              select: {
                id: true,
                fullName: true,
                email: true,
                phoneNumber: true,
                profileImageUrl: true,
                createdAt: true,
              },
            },
            pharmacy_documents: {
              include: {
                document_files: {
                  select: {
                    id: true,
                    original_file_name: true,
                    file_path: true,
                    file_size: true,
                    mime_type: true,
                    created_at: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!pvr)
      throw new ApiError(404, "Pharmacy verification request not found");

    const pharmacy = pvr.pharmacy_profiles;
    const owner = pharmacy?.users;

    let mappedStatus = "Pending";
    if (pvr.status === "approved") mappedStatus = "Approved";
    else if (pvr.status === "rejected") mappedStatus = "Failed";

    return {
      id: pvr.id,
      status: mappedStatus,
      rawStatus: pvr.status,
      riskIndicator:
        pvr.status === "rejected"
          ? "High"
          : pvr.status === "approved"
            ? "Low"
            : "Medium",
      priority: pvr.priority,
      requestType: pvr.requestType,
      submittedAt: pvr.submittedAt,
      reviewedAt: pvr.reviewedAt,
      completedAt: pvr.completedAt,
      requestNotes: pvr.requestNotes,
      rejectionReason: pvr.rejectionReason,
      reviewNotes: pvr.reviewNotes,

      contact: {
        fullName: owner?.fullName ?? "",
        phone: owner?.phoneNumber ?? pharmacy?.phone ?? "",
        email: owner?.email ?? pharmacy?.email ?? "",
        location: pharmacy?.address ?? "",
        registrationDate: owner?.createdAt
          ? new Date(owner.createdAt).toLocaleDateString("en-GB")
          : "",
        profileImageUrl: owner?.profileImageUrl ?? null,
      },

      business: {
        businessName: pharmacy?.pharmacyName ?? "",
        registrationNumber: pharmacy?.registrationNumber ?? "",
        businessAddress: pharmacy?.address ?? "",
        licenseNumber: pharmacy?.licenseNumber ?? "",
        licenseExpiryDate: pharmacy?.licenseExpiryDate ?? null,
        website: pharmacy?.website ?? "",
        description: pharmacy?.description ?? "",
        operatingHours: pharmacy?.operatingHours ?? null,
      },

      documents: (pharmacy?.pharmacy_documents ?? []).map((doc) => ({
        id: doc.id,
        name: doc.documentName,
        documentType: doc.documentType,
        isVerified: doc.isVerified,
        submissionStatus: doc.submissionStatus,
        verificationNotes: doc.verificationNotes,
        createdAt: doc.createdAt,
        file: doc.document_files
          ? {
              id: doc.document_files.id,
              name: doc.document_files.original_file_name,
              path: doc.document_files.file_path,
              size: Number(doc.document_files.file_size),
              mimeType: doc.document_files.mime_type,
            }
          : null,
      })),
    };
  }

  // ── APPROVE / REJECT PHARMACY ────────────────────────────────────────────────

  /**
   * PATCH /api/verification/pharmacies/:id/approve
   */
  async approvePharmacy({ id, adminUserId, reviewNotes, req }) {
    const pvr = await mainPrisma.pharmacy_verification_requests.findUnique({
      where: { id },
      include: { pharmacy_profiles: { select: { id: true, userId: true } } },
    });
    if (!pvr)
      throw new ApiError(404, "Pharmacy verification request not found");
    if (pvr.status === "approved") {
      throw new ApiError(400, "Already approved");
    }

    const adminUser = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { mainAppUserId: true },
    });

    const now = new Date();

    await mainPrisma.$transaction(async (tx) => {
      await tx.pharmacy_verification_requests.update({
        where: { id },
        data: {
          status: "approved",
          reviewedAt: now,
          completedAt: now,
          reviewNotes: reviewNotes ?? pvr.reviewNotes,
          reviewedBy: adminUser?.mainAppUserId ?? null,
        },
      });

      // Sync pharmacy profile verification status
      if (pvr.pharmacy_profiles?.id) {
        await tx.pharmacy_profiles.update({
          where: { id: pvr.pharmacy_profiles.id },
          data: { verificationStatus: "approved", isActive: true },
        });
      }
    });

    await createAuditLog({
      adminUserId,
      action: "USER_UPDATED",
      targetId: id,
      targetType: "pharmacy_verification_request",
      metadata: { action: "approved", pharmacyId: pvr.pharmacyId, reviewNotes },
      req,
    });

    return { id, status: "Approved" };
  }

  /**
   * PATCH /api/verification/pharmacies/:id/reject
   */
  async rejectPharmacy({ id, adminUserId, rejectionReason, reviewNotes, req }) {
    if (!rejectionReason) {
      throw new ApiError(400, "Rejection reason is required");
    }

    const pvr = await mainPrisma.pharmacy_verification_requests.findUnique({
      where: { id },
      include: { pharmacy_profiles: { select: { id: true } } },
    });
    if (!pvr)
      throw new ApiError(404, "Pharmacy verification request not found");

    const adminUser = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { mainAppUserId: true },
    });

    const now = new Date();

    await mainPrisma.$transaction(async (tx) => {
      await tx.pharmacy_verification_requests.update({
        where: { id },
        data: {
          status: "rejected",
          reviewedAt: now,
          completedAt: now,
          rejectionReason,
          reviewNotes: reviewNotes ?? pvr.reviewNotes,
          reviewedBy: adminUser?.mainAppUserId ?? null,
        },
      });

      if (pvr.pharmacy_profiles?.id) {
        await tx.pharmacy_profiles.update({
          where: { id: pvr.pharmacy_profiles.id },
          data: { verificationStatus: "rejected" },
        });
      }
    });

    await createAuditLog({
      adminUserId,
      action: "USER_UPDATED",
      targetId: id,
      targetType: "pharmacy_verification_request",
      metadata: {
        action: "rejected",
        pharmacyId: pvr.pharmacyId,
        rejectionReason,
        reviewNotes,
      },
      req,
    });

    return { id, status: "Failed" };
  }

  // ── LAB VERIFICATIONS ────────────────────────────────────────────────────────

  /**
   * GET /api/verification/labs
   * Labs use lab_facilities — status field is the verification state.
   */
  async getLabVerifications({
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
    search,
  }) {
    const where = {};

    if (status && status !== "All") {
      if (status === "Approved") {
        where.status = { in: ["approved", "active"] };
      } else if (status === "Failed") {
        where.status = { in: ["rejected", "suspended"] };
      } else {
        where.status = { in: ["draft", "pending_approval", "inactive"] };
      }
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    if (search) {
      where.OR = [
        { facilityName: { contains: search, mode: "insensitive" } },
        { registrationNumber: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [total, rows] = await Promise.all([
      mainPrisma.lab_facilities.count({ where }),
      mainPrisma.lab_facilities.findMany({
        where,
        select: {
          id: true,
          facilityName: true,
          facilityType: true,
          registrationNumber: true,
          licenseNumber: true,
          email: true,
          phone: true,
          status: true,
          createdAt: true,
          adminFullName: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: Number(limit),
      }),
    ]);

    const shaped = rows.map((lab) => {
      let mappedStatus = "Pending";
      if (["approved", "active"].includes(lab.status))
        mappedStatus = "Approved";
      else if (["rejected", "suspended"].includes(lab.status))
        mappedStatus = "Failed";

      return {
        id: lab.id,
        user: lab.facilityName ?? lab.adminFullName ?? "Unknown",
        role: "Labs",
        verificationType: "Business",
        licenseId: lab.licenseNumber ?? lab.registrationNumber ?? "",
        status: mappedStatus,
        rawStatus: lab.status,
        submittedDate: lab.createdAt
          ? new Date(lab.createdAt).toLocaleDateString("en-GB")
          : null,
        riskIndicator: ["rejected", "suspended"].includes(lab.status)
          ? "High"
          : ["approved", "active"].includes(lab.status)
            ? "Low"
            : "Medium",
        facilityType: lab.facilityType,
      };
    });

    return {
      requests: shaped,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
        totalItems: total,
        itemsPerPage: Number(limit),
      },
    };
  }

  // ── LAB DETAIL ───────────────────────────────────────────────────────────────

  /**
   * GET /api/verification/labs/:id
   */
  async getLabVerificationById(id) {
    const lab = await mainPrisma.lab_facilities.findUnique({
      where: { id },
      include: {
        users_lab_facilities_adminUserIdTousers: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phoneNumber: true,
            profileImageUrl: true,
            createdAt: true,
          },
        },
        users_lab_facilities_approvedByIdTousers: {
          select: { id: true, fullName: true },
        },
      },
    });

    if (!lab) throw new ApiError(404, "Lab facility not found");

    const admin = lab.users_lab_facilities_adminUserIdTousers;

    let mappedStatus = "Pending";
    if (["approved", "active"].includes(lab.status)) mappedStatus = "Approved";
    else if (["rejected", "suspended"].includes(lab.status))
      mappedStatus = "Failed";

    return {
      id: lab.id,
      status: mappedStatus,
      rawStatus: lab.status,
      riskIndicator: ["rejected", "suspended"].includes(lab.status)
        ? "High"
        : ["approved", "active"].includes(lab.status)
          ? "Low"
          : "Medium",
      createdAt: lab.createdAt,
      approvedAt: lab.approvedAt,
      rejectedAt: lab.rejectedAt,
      rejectionReason: lab.rejectionReason,

      contact: {
        fullName: lab.adminFullName ?? admin?.fullName ?? "",
        phone: lab.adminPhone ?? admin?.phoneNumber ?? lab.phone ?? "",
        email: lab.adminEmail ?? admin?.email ?? lab.email ?? "",
        location: [lab.city, lab.state, lab.country].filter(Boolean).join(", "),
        registrationDate: lab.createdAt
          ? new Date(lab.createdAt).toLocaleDateString("en-GB")
          : "",
        profileImageUrl: admin?.profileImageUrl ?? null,
      },

      business: {
        businessName: lab.facilityName ?? "",
        registrationNumber: lab.registrationNumber ?? "",
        licenseNumber: lab.licenseNumber ?? "",
        facilityType: lab.facilityType,
        businessAddress: lab.address ?? "",
        city: lab.city,
        state: lab.state,
        country: lab.country,
        website: lab.website ?? "",
        phone: lab.phone ?? "",
        email: lab.email ?? "",
        staffCount: lab.staffCount,
        operatingHours: lab.operatingHours,
        servicesOffered: lab.servicesOffered,
        equipmentList: lab.equipmentList,
      },

      documents: [
        lab.licenseDocument
          ? {
              name: "License Document",
              url: lab.licenseDocument,
              type: "license",
            }
          : null,
        lab.registrationDocument
          ? {
              name: "Registration Document",
              url: lab.registrationDocument,
              type: "registration",
            }
          : null,
        lab.accreditationDocument
          ? {
              name: "Accreditation Document",
              url: lab.accreditationDocument,
              type: "accreditation",
            }
          : null,
      ].filter(Boolean),

      approvedBy: lab.users_lab_facilities_approvedByIdTousers ?? null,
    };
  }

  // ── APPROVE / REJECT LAB ─────────────────────────────────────────────────────

  /**
   * PATCH /api/verification/labs/:id/approve
   */
  async approveLab({ id, adminUserId, req }) {
    // 1. Find the lab
    const lab = await mainPrisma.lab_facilities.findUnique({ where: { id } });
    if (!lab) throw new ApiError(404, "Lab facility not found");
    if (["approved", "active"].includes(lab.status)) {
      throw new ApiError(400, "Lab is already approved");
    }

    // 2. Find the admin user
    const adminUser = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { mainAppUserId: true },
    });

    const now = new Date();

    // 3. Check if user account already exists for this lab
    const existingUser = await mainPrisma.users.findUnique({
      where: { email: lab.adminEmail },
    });

    let labUserId = existingUser?.id ?? null;
    let tempPassword = null;

    // 4. Only create user account if it doesn't exist yet
    if (!existingUser) {
      tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);

      const newUser = await mainPrisma.users.create({
        data: {
          email: lab.adminEmail,
          fullName: lab.adminFullName,
          passwordHash,
          role: "lab",
          status: "active",
          mustChangePassword: true,
          phoneNumber: lab.adminPhone ?? null,
        },
      });

      labUserId = newUser.id;
    }

    // 5. Update lab + create audit log in main DB
    await mainPrisma.$transaction(async (tx) => {
      await tx.lab_facilities.update({
        where: { id },
        data: {
          status: "approved",
          approvedAt: now,
          approvedById: adminUser?.mainAppUserId ?? null,
          adminUserId: labUserId,
          adminUserCreated: true,
          adminInvitationSent: true,
        },
      });

      await tx.audit_logs.create({
        data: {
          resourceType: "lab_facility",
          resourceId: id,
          action: "approved",
          actorUserId: adminUser?.mainAppUserId ?? null,
          actorRole: "admin",
          facilityId: id,
          metadata: {
            facilityName: lab.facilityName,
            adminEmail: lab.adminEmail,
            adminUserCreated: !existingUser,
          },
        },
      });
    });

    // 6. Send approval email only if new account was created
    if (tempPassword) {
      await sendLabApprovalEmail({
        to: lab.adminEmail,
        fullName: lab.adminFullName,
        tempPassword,
      });
    }

    // 7. Audit log in admin DB
    await createAuditLog({
      adminUserId,
      action: "USER_UPDATED",
      targetId: id,
      targetType: "lab_facility",
      metadata: {
        action: "approved",
        facilityName: lab.facilityName,
        adminUserCreated: !existingUser,
        labUserId,
      },
      req,
    });

    return { id, status: "Approved" };
  }
  /**
   * PATCH /api/verification/labs/:id/reject
   */
  async rejectLab({ id, adminUserId, rejectionReason, req }) {
    if (!rejectionReason) {
      throw new ApiError(400, "Rejection reason is required");
    }

    const lab = await mainPrisma.lab_facilities.findUnique({ where: { id } });
    if (!lab) throw new ApiError(404, "Lab facility not found");

    const adminUser = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { mainAppUserId: true },
    });

    await mainPrisma.lab_facilities.update({
      where: { id },
      data: {
        status: "rejected",
        rejectedAt: new Date(),
        rejectionReason,
        approvedById: adminUser?.mainAppUserId ?? null,
      },
    });

    await createAuditLog({
      adminUserId,
      action: "USER_UPDATED",
      targetId: id,
      targetType: "lab_facility",
      metadata: {
        action: "rejected",
        facilityName: lab.facilityName,
        rejectionReason,
      },
      req,
    });

    return { id, status: "Failed" };
  }

  // ── COMBINED LIST (for "All" tab) ─────────────────────────────────────────────

  /**
   * GET /api/verification/all
   *
   * Strategy: run three lightweight DB queries in parallel — each fetches only
   * the current page window worth of rows (limit rows, sorted by date desc).
   * We then merge-sort the three small arrays and slice to one page.
   *
   * This avoids the "fetch 9999 rows into memory" anti-pattern while still
   * giving correct cross-source date ordering within a page.
   *
   * Trade-off: total item count is the sum of three independent counts, which
   * is accurate. The merge-sort is O(3 * limit) — negligible.
   */
  async getAllCombined({
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
    search,
  }) {
    const p = Number(page);
    const l = Number(limit);
    const fetchLimit = p * l;

    const buildDateFilter = (field) => {
      if (!startDate && !endDate) return {};
      const filter = {};
      if (startDate) filter.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.lte = end;
      }
      return { [field]: filter };
    };

    // WHERE clauses (keep exactly as you have them)
    const doctorWhere = {};
    if (status && status !== "All") {
      if (status === "Approved") doctorWhere.status = "approved";
      else if (status === "Failed")
        doctorWhere.status = { in: ["rejected", "expired"] };
      else
        doctorWhere.status = {
          in: [
            "pending",
            "in_progress",
            "pending_documents",
            "api_verification",
            "manual_review",
          ],
        };
    }
    Object.assign(doctorWhere, buildDateFilter("submittedAt"));
    if (search) {
      doctorWhere.OR = [
        { licenseNumber: { contains: search, mode: "insensitive" } },
        {
          users_verification_requests_doctorIdTousers: {
            fullName: { contains: search, mode: "insensitive" },
          },
        },
      ];
    }

    const pharmacyWhere = {};
    if (status && status !== "All") {
      if (status === "Approved") pharmacyWhere.status = "approved";
      else if (status === "Failed") pharmacyWhere.status = "rejected";
      else
        pharmacyWhere.status = {
          in: ["pending", "in_progress", "requires_changes"],
        };
    }
    Object.assign(pharmacyWhere, buildDateFilter("submittedAt"));
    if (search) {
      pharmacyWhere.pharmacy_profiles = {
        OR: [
          { pharmacyName: { contains: search, mode: "insensitive" } },
          { registrationNumber: { contains: search, mode: "insensitive" } },
        ],
      };
    }

    const labWhere = {};
    if (status && status !== "All") {
      if (status === "Approved")
        labWhere.status = { in: ["approved", "active"] };
      else if (status === "Failed")
        labWhere.status = { in: ["rejected", "suspended"] };
      else labWhere.status = { in: ["draft", "pending_approval", "inactive"] };
    }
    Object.assign(labWhere, buildDateFilter("createdAt"));
    if (search) {
      labWhere.OR = [
        { facilityName: { contains: search, mode: "insensitive" } },
        { registrationNumber: { contains: search, mode: "insensitive" } },
      ];
    }

    // ── Doctors + Pharmacies + Stats run in parallel (stable tables) ──
    const [
      doctorTotal,
      doctorRows,
      pharmacyTotal,
      pharmacyRows,
      statsTotal,
      statsApproved,
      statsPending,
    ] = await Promise.all([
      mainPrisma.verification_requests.count({ where: doctorWhere }),
      mainPrisma.verification_requests.findMany({
        where: doctorWhere,
        include: {
          users_verification_requests_doctorIdTousers: {
            select: {
              id: true,
              fullName: true,
              profileImageUrl: true,
              doctor_profiles: {
                select: {
                  professional_licenses: {
                    select: {
                      areasOfSpecialization: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { submittedAt: "desc" },
        take: fetchLimit,
      }),

      mainPrisma.pharmacy_verification_requests.count({ where: pharmacyWhere }),
      mainPrisma.pharmacy_verification_requests.findMany({
        where: pharmacyWhere,
        include: {
          pharmacy_profiles: {
            select: {
              pharmacyName: true,
              licenseNumber: true,
              registrationNumber: true,
            },
          },
        },
        orderBy: { submittedAt: "desc" },
        take: fetchLimit,
      }),

      mainPrisma.verification_requests.count(),
      mainPrisma.verification_requests.count({ where: { status: "approved" } }),
      mainPrisma.verification_requests.count({
        where: {
          status: {
            in: [
              "pending",
              "in_progress",
              "pending_documents",
              "api_verification",
              "manual_review",
            ],
          },
        },
      }),
    ]);

    // ── Labs: graceful fallback if table doesn't exist yet ──
    let labTotal = 0;
    let labRows = [];
    try {
      [labTotal, labRows] = await Promise.all([
        mainPrisma.lab_facilities.count({ where: labWhere }),
        mainPrisma.lab_facilities.findMany({
          where: labWhere,
          select: {
            id: true,
            facilityName: true,
            licenseNumber: true,
            registrationNumber: true,
            status: true,
            facilityType: true,
            createdAt: true,
            adminFullName: true,
          },
          orderBy: { createdAt: "desc" },
          take: fetchLimit,
        }),
      ]);
    } catch (err) {
      // Table not migrated yet — return empty, don't crash the whole endpoint
      console.warn("lab_facilities table not available:", err.message);
    }

    // ── Shape each source ──
    const shapedDoctors = doctorRows.map((vr) => {
      const user = vr.users_verification_requests_doctorIdTousers;

      // Get specialty
      let specialty = null;
      if (user?.doctor_profiles?.professional_licenses?.areasOfSpecialization) {
        const specialties =
          user.doctor_profiles.professional_licenses.areasOfSpecialization;
        specialty = specialties.length > 0 ? specialties[0] : null;
      }

      return {
        id: vr.id,
        user: user?.fullName ?? "Unknown",
        role: "Doctors",
        verificationType: "License",
        licenseId: vr.licenseNumber,
        status: mapStatus(vr.status),
        submittedDate: vr.submittedAt
          ? new Date(vr.submittedAt).toLocaleDateString("en-GB")
          : null,
        _sortDate: vr.submittedAt ? new Date(vr.submittedAt).getTime() : 0,
        riskIndicator: deriveRiskIndicator(vr),
        profileImageUrl: user?.profileImageUrl ?? null,
        specialty: specialty,
      };
    });

    const shapedPharmacies = pharmacyRows.map((pvr) => {
      const pharmacy = pvr.pharmacy_profiles;
      let mappedStatus = "Pending";
      if (pvr.status === "approved") mappedStatus = "Approved";
      else if (pvr.status === "rejected") mappedStatus = "Failed";
      return {
        id: pvr.id,
        user: pharmacy?.pharmacyName ?? "Unknown",
        role: "Pharmacies",
        verificationType: "Business",
        licenseId:
          pharmacy?.licenseNumber ?? pharmacy?.registrationNumber ?? "",
        status: mappedStatus,
        submittedDate: pvr.submittedAt
          ? new Date(pvr.submittedAt).toLocaleDateString("en-GB")
          : null,
        _sortDate: pvr.submittedAt ? new Date(pvr.submittedAt).getTime() : 0,
        riskIndicator:
          pvr.status === "rejected"
            ? "High"
            : pvr.status === "approved"
              ? "Low"
              : "Medium",
      };
    });

    const shapedLabs = labRows.map((lab) => {
      let mappedStatus = "Pending";
      if (["approved", "active"].includes(lab.status))
        mappedStatus = "Approved";
      else if (["rejected", "suspended"].includes(lab.status))
        mappedStatus = "Failed";
      return {
        id: lab.id,
        user: lab.facilityName ?? lab.adminFullName ?? "Unknown",
        role: "Labs",
        verificationType: "Business",
        licenseId: lab.licenseNumber ?? lab.registrationNumber ?? "",
        status: mappedStatus,
        submittedDate: lab.createdAt
          ? new Date(lab.createdAt).toLocaleDateString("en-GB")
          : null,
        _sortDate: lab.createdAt ? new Date(lab.createdAt).getTime() : 0,
        riskIndicator: ["rejected", "suspended"].includes(lab.status)
          ? "High"
          : ["approved", "active"].includes(lab.status)
            ? "Low"
            : "Medium",
      };
    });

    // ── Merge-sort + paginate ──
    const merged = [...shapedDoctors, ...shapedPharmacies, ...shapedLabs].sort(
      (a, b) => b._sortDate - a._sortDate,
    );

    const skip = (p - 1) * l;
    const paginated = merged
      .slice(skip, skip + l)
      .map(({ _sortDate, ...rest }) => rest);

    const totalItems = doctorTotal + pharmacyTotal + labTotal;
    const approvalRate =
      statsTotal > 0 ? ((statsApproved / statsTotal) * 100).toFixed(1) : "0";

    return {
      stats: {
        totalRequests: statsTotal,
        approvalRate: `${approvalRate}%`,
        pendingRequests: statsPending,
      },
      requests: paginated,
      pagination: {
        currentPage: p,
        totalPages: Math.ceil(totalItems / l),
        totalItems,
        itemsPerPage: l,
      },
    };
  }
}

module.exports = new VerificationService();
