const { prisma } = require("../../shared/config/database");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const ApiError = require("../../shared/utils/ApiError");

// Tiers that can see their own sensitive fields (salary, bonus, equity)
const SENSITIVE_TIERS = ["SUPER", "EXECUTIVE"];

class ProfileService {
  // ─────────────────────────────────────────────────────────────────────────
  // GET /profile/me
  // ─────────────────────────────────────────────────────────────────────────
  async getMyProfile(adminUserId) {
    const user = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: {
        id: true,
        email: true,
        name: true,
        position: true,
        department: true,
        tier: true,
        status: true,
        isTeamLead: true,
        lastLoginAt: true,
        createdAt: true,
        mainAppUserId: true,
        avatarUrl: true,

        // Personal Info
        preferredName: true,
        birthday: true,
        nationality: true,
        gender: true,
        maritalStatus: true,

        // Contact Info
        workPhone: true,
        homePhone: true,
        personalPhone: true,
        fax: true,
        address: true,
        state: true,
        country: true,

        // Emergency Contact
        emergencyName: true,
        emergencyPhone: true,
        emergencyEmail: true,
        emergencyRelation: true,

        // Employment Details
        employmentType: true,
        employmentCategory: true,
        location: true,

        // Sensitive
        salary: true,
        bonus: true,
        equity: true,

        // Relations
        socialLinks: {
          select: { id: true, platform: true, username: true },
        },
        educations: {
          select: {
            id: true,
            degreeTitle: true,
            institution: true,
            from: true,
            to: true,
          },
          orderBy: { createdAt: "asc" },
        },
        // Documents are read-only for employees — uploaded by SUPER/EXECUTIVE
        documents: {
          select: { id: true, name: true, type: true, uploadedAt: true },
          orderBy: { uploadedAt: "desc" },
        },
        // Performance notes are read-only — written by SUPER/EXECUTIVE
        performanceNotes: {
          select: { id: true, title: true, type: true, date: true, url: true }, // 👈 add url
          orderBy: { date: "desc" },
        },
        // Reports are created by the employee themselves
        reports: {
          select: {
            id: true,
            title: true,
            type: true,
            date: true,
            body: true,
            note: true,
          },
          orderBy: { date: "desc" },
        },
      },
    });

    if (!user) throw new ApiError(404, "User not found");

    // Hide salary/bonus/equity from non-privileged users
    // if (!SENSITIVE_TIERS.includes(user.tier)) {
    //   delete user.salary;
    //   delete user.bonus;
    //   delete user.equity;
    // }

    return user;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /profile/me/personal
  // ─────────────────────────────────────────────────────────────────────────
  async updatePersonalInfo({ adminUserId, data, req }) {
    const allowed = [
      "preferredName",
      "birthday",
      "nationality",
      "gender",
      "maritalStatus",
    ];
    const update = this._pick(data, allowed);

    // ✅ Convert "1999-04-17" → "1999-04-17T00:00:00.000Z"
    if (update.birthday) {
      update.birthday = new Date(update.birthday).toISOString();
    }

    const updated = await prisma.adminUser.update({
      where: { id: adminUserId },
      data: update,
      select: {
        preferredName: true,
        birthday: true,
        nationality: true,
        gender: true,
        maritalStatus: true,
      },
    });

    await createAuditLog({
      adminUserId,
      action: "PROFILE_UPDATED",
      targetId: adminUserId,
      targetType: "admin_user",
      metadata: { section: "personal_info", changes: update },
      req,
    });

    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /profile/me/contact
  // ─────────────────────────────────────────────────────────────────────────
  async updateContactInfo({ adminUserId, data, req }) {
    const allowed = [
      "workPhone",
      "homePhone",
      "personalPhone",
      "fax",
      "address",
      "state",
      "country",
    ];
    const update = this._pick(data, allowed);

    const updated = await prisma.adminUser.update({
      where: { id: adminUserId },
      data: update,
      select: {
        workPhone: true,
        homePhone: true,
        personalPhone: true,
        fax: true,
        address: true,
        state: true,
        country: true,
      },
    });

    await createAuditLog({
      adminUserId,
      action: "PROFILE_UPDATED",
      targetId: adminUserId,
      targetType: "admin_user",
      metadata: { section: "contact_info", changes: update },
      req,
    });

    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /profile/me/emergency
  // ─────────────────────────────────────────────────────────────────────────
  async updateEmergencyContact({ adminUserId, data, req }) {
    const allowed = [
      "emergencyName",
      "emergencyPhone",
      "emergencyEmail",
      "emergencyRelation",
    ];
    const update = this._pick(data, allowed);

    const updated = await prisma.adminUser.update({
      where: { id: adminUserId },
      data: update,
      select: {
        emergencyName: true,
        emergencyPhone: true,
        emergencyEmail: true,
        emergencyRelation: true,
      },
    });

    await createAuditLog({
      adminUserId,
      action: "PROFILE_UPDATED",
      targetId: adminUserId,
      targetType: "admin_user",
      metadata: { section: "emergency_contact", changes: update },
      req,
    });

    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /profile/me/social
  // ─────────────────────────────────────────────────────────────────────────
  async updateSocialLinks({ adminUserId, links, req }) {
    await prisma.adminSocialLink.deleteMany({ where: { adminUserId } });

    if (links.length > 0) {
      await prisma.adminSocialLink.createMany({
        data: links.map((l) => ({
          adminUserId,
          platform: l.platform,
          username: l.username,
        })),
      });
    }

    await createAuditLog({
      adminUserId,
      action: "PROFILE_UPDATED",
      targetId: adminUserId,
      targetType: "admin_user",
      metadata: { section: "social_links", count: links.length },
      req,
    });

    return prisma.adminSocialLink.findMany({
      where: { adminUserId },
      select: { id: true, platform: true, username: true },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /profile/me/education
  // ─────────────────────────────────────────────────────────────────────────
  async updateEducation({ adminUserId, entries, req }) {
    await prisma.adminEducation.deleteMany({ where: { adminUserId } });

    if (entries.length > 0) {
      await prisma.adminEducation.createMany({
        data: entries.map((e) => ({
          adminUserId,
          degreeTitle: e.degreeTitle,
          institution: e.institution,
          from: e.from || null,
          to: e.to || null,
        })),
      });
    }

    await createAuditLog({
      adminUserId,
      action: "PROFILE_UPDATED",
      targetId: adminUserId,
      targetType: "admin_user",
      metadata: { section: "education", count: entries.length },
      req,
    });

    return prisma.adminEducation.findMany({
      where: { adminUserId },
      select: {
        id: true,
        degreeTitle: true,
        institution: true,
        from: true,
        to: true,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /profile/me/reports
  // Employee writes a text-based report (leave resumption, milestone, etc.)
  // No file upload — body is plain text written in the app
  // ─────────────────────────────────────────────────────────────────────────
  async addReport({ adminUserId, title, body, note, req }) {
    const report = await prisma.adminReport.create({
      data: {
        adminUserId,
        title,
        body: body || null,
        note: note || null,
        createdBy: adminUserId,
      },
      select: {
        id: true,
        title: true,
        type: true,
        date: true,
        body: true,
        note: true,
      },
    });

    await createAuditLog({
      adminUserId,
      action: "PROFILE_UPDATED",
      targetId: report.id,
      targetType: "admin_report",
      metadata: { section: "reports", title },
      req,
    });

    return report;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /profile/me/documents/:id/download
  // Documents are uploaded by SUPER/EXECUTIVE — employee can only download
  // ─────────────────────────────────────────────────────────────────────────
  async getDocumentDownloadUrl({ adminUserId, documentId }) {
    const doc = await prisma.adminDocument.findUnique({
      where: { id: documentId },
    });

    if (!doc) throw new ApiError(404, "Document not found");
    if (doc.adminUserId !== adminUserId) {
      throw new ApiError(
        403,
        "You do not have permission to access this document",
      );
    }

    return { url: doc.url, name: doc.name, type: doc.type };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /profile/me/reports/:id
  // Returns a single report with full body
  // ─────────────────────────────────────────────────────────────────────────
  async getReport({ adminUserId, reportId }) {
    const report = await prisma.adminReport.findUnique({
      where: { id: reportId },
    });

    if (!report) throw new ApiError(404, "Report not found");
    if (report.adminUserId !== adminUserId) {
      throw new ApiError(
        403,
        "You do not have permission to access this report",
      );
    }

    return report;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /profile/me/avatar
  // Uploads new avatar to Cloudinary, deletes old one, saves URL to DB
  // ─────────────────────────────────────────────────────────────────────────
  async updateAvatar({ adminUserId, file, req }) {
    const cloudinary = require("../../shared/config/cloudinary");
    const { Readable } = require("stream");

    // Get existing avatar so we can delete it from Cloudinary after upload
    const existing = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { avatarCloudinaryId: true },
    });

    // Upload new image to Cloudinary
    const cloudinaryResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `admin-avatars`,
          public_id: `avatar-${adminUserId}`, // fixed ID so it auto-overwrites
          overwrite: true,
          resource_type: "image",
          transformation: [
            { width: 400, height: 400, crop: "fill", gravity: "face" },
          ],
        },
        (error, result) => {
          if (error) return reject(new ApiError(500, "Avatar upload failed"));
          resolve(result);
        },
      );
      const readable = new Readable();
      readable.push(file.buffer);
      readable.push(null);
      readable.pipe(uploadStream);
    });

    // Save new URL and cloudinaryId to DB
    const updated = await prisma.adminUser.update({
      where: { id: adminUserId },
      data: {
        avatarUrl: cloudinaryResult.secure_url,
        avatarCloudinaryId: cloudinaryResult.public_id,
      },
      select: { avatarUrl: true },
    });

    await createAuditLog({
      adminUserId,
      action: "AVATAR_UPDATED",
      targetId: adminUserId,
      targetType: "admin_user",
      metadata: { cloudinaryId: cloudinaryResult.public_id },
      req,
    });

    return updated;
  }

  async getMyProjects(adminUserId) {
    const memberships = await prisma.projectMember.findMany({
      where: { adminUserId },
      include: {
        project: {
          include: {
            team: {
              select: {
                title: true,
                members: {
                  where: { isTeamLead: true },
                  include: {
                    adminUser: { select: { name: true } },
                  },
                  take: 1,
                },
              },
            },
            assignees: { select: { id: true } },
          },
        },
      },
    });

    return memberships.map(({ project }) => ({
      id: project.id,
      title: project.title,
      assignedDate: project.assignedDate,
      dueDate: project.dueDate,
      status: project.status,
      team: project.team.title,
      teamLead: project.team.members[0]?.adminUser.name ?? "—",
      members: project.assignees.length,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /profile/me/projects/:id
  // Full project detail — description, members with avatars, team lead avatar
  // ─────────────────────────────────────────────────────────────────────────
  async getMyProjectDetail({ adminUserId, projectId }) {
    // Verify the user is actually a member of this project
    const membership = await prisma.projectMember.findUnique({
      where: {
        projectId_adminUserId: {
          projectId,
          adminUserId,
        },
      },
    });

    if (!membership) {
      throw new ApiError(403, "You are not a member of this project");
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        team: {
          select: {
            title: true,
            members: {
              include: {
                adminUser: {
                  select: { id: true, name: true, avatarUrl: true },
                },
              },
            },
          },
        },
        assignees: {
          include: {
            adminUser: {
              select: { id: true, name: true, avatarUrl: true },
            },
          },
        },
      },
    });

    if (!project) throw new ApiError(404, "Project not found");

    const teamLead = project.team.members.find((m) => m.isTeamLead);

    return {
      id: project.id,
      title: project.title,
      description: project.description,
      assignedDate: project.assignedDate,
      dueDate: project.dueDate,
      status: project.status,
      team: project.team.title,
      teamLead: teamLead
        ? {
            name: teamLead.adminUser.name,
            avatarUrl: teamLead.adminUser.avatarUrl,
          }
        : null,
      members: project.assignees.map(({ adminUser }) => ({
        id: adminUser.id,
        name: adminUser.name,
        avatarUrl: adminUser.avatarUrl,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /profile/me/tasks
  // All tasks where the logged-in user is the assignee
  // ─────────────────────────────────────────────────────────────────────────
  async getMyTasks(adminUserId) {
    const tasks = await prisma.task.findMany({
      where: { assigneeId: adminUserId },
      select: {
        id: true,
        title: true,
        assignedDate: true,
        dueDate: true,
        status: true,
        assigner: {
          select: { name: true },
        },
      },
      orderBy: { assignedDate: "desc" },
    });

    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      assignedDate: task.assignedDate,
      dueDate: task.dueDate,
      status: task.status,
      assigner: task.assigner.name,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /profile/me/tasks/:id
  // Single task detail — includes description and assigner avatar
  // ─────────────────────────────────────────────────────────────────────────
  async getMyTaskDetail({ adminUserId, taskId }) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assigner: {
          select: { name: true, avatarUrl: true },
        },
      },
    });

    if (!task) throw new ApiError(404, "Task not found");

    if (task.assigneeId !== adminUserId) {
      throw new ApiError(403, "You do not have permission to view this task");
    }

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      assignedDate: task.assignedDate,
      dueDate: task.dueDate,
      status: task.status,
      assigner: {
        name: task.assigner.name,
        avatarUrl: task.assigner.avatarUrl,
      },
    };
  }
  // ─────────────────────────────────────────────────────────────────────────
  // GET /profile/me/teams
  // All teams the logged-in user is a member of, with member avatars
  // ─────────────────────────────────────────────────────────────────────────
  async getMyTeams(adminUserId) {
    const memberships = await prisma.teamMember.findMany({
      where: { adminUserId },
      include: {
        team: {
          include: {
            members: {
              include: {
                adminUser: {
                  select: { id: true, name: true, avatarUrl: true },
                },
              },
            },
          },
        },
      },
    });

    return memberships.map(({ team }) => ({
      id: team.id,
      title: team.title,
      members: team.members.map(({ adminUser }) => ({
        id: adminUser.id,
        name: adminUser.name,
        avatarUrl: adminUser.avatarUrl ?? null,
      })),
    }));
  }
  // ─────────────────────────────────────────────────────────────────────────
  // Private — pick only allowed keys from object
  // ─────────────────────────────────────────────────────────────────────────
  _pick(obj, allowedKeys) {
    return Object.fromEntries(
      Object.entries(obj).filter(([key]) => allowedKeys.includes(key)),
    );
  }
}

module.exports = new ProfileService();
