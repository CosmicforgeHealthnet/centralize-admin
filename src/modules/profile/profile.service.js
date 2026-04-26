const { prisma } = require("../../shared/config/database");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const ApiError = require("../../shared/utils/ApiError");
const notificationService = require("../notifications/notifications.service");

const SENSITIVE_TIERS = ["SUPER", "EXECUTIVE"];

class ProfileService {
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
        documents: {
          select: { id: true, name: true, type: true, uploadedAt: true },
          orderBy: { uploadedAt: "desc" },
        },
        performanceNotes: {
          select: { id: true, title: true, type: true, date: true, url: true },
          orderBy: { date: "desc" },
        },
        reports: {
          select: {
            id: true,
            title: true,
            type: true,
            date: true,
            body: true,
            note: true,
            url: true,
          },
          orderBy: { date: "desc" },
        },
      },
    });

    if (!user) throw new ApiError(404, "User not found");

    return user;
  }

  async updatePersonalInfo({ adminUserId, data, req }) {
    const allowed = [
      "preferredName",
      "birthday",
      "nationality",
      "gender",
      "maritalStatus",
    ];
    const update = this._pick(data, allowed);

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

    await notificationService.createNotification({
      adminUserId,
      icon: "check",
      title: "Profile Updated",
      subtitle: "Your personal information has been updated successfully.",
    });

    return updated;
  }

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

    await notificationService.createNotification({
      adminUserId,
      icon: "check",
      title: "Contact Info Updated",
      subtitle: "Your contact information has been updated successfully.",
    });

    return updated;
  }

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

    await notificationService.createNotification({
      adminUserId,
      icon: "check",
      title: "Emergency Contact Updated",
      subtitle: "Your emergency contact information has been updated.",
    });

    return updated;
  }

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

    await notificationService.createNotification({
      adminUserId,
      icon: "check",
      title: "Social Links Updated",
      subtitle: "Your social media links have been updated.",
    });

    return prisma.adminSocialLink.findMany({
      where: { adminUserId },
      select: { id: true, platform: true, username: true },
    });
  }

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

    await notificationService.createNotification({
      adminUserId,
      icon: "check",
      title: "Education Updated",
      subtitle: "Your education history has been updated.",
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

  async addReport({ adminUserId, file, title, body, note, req }) {
    let url = null;
    let cloudinaryId = null;
    let typeLabel = "text";

    if (file && file.size > 0 && file.buffer) {
      const cloudinary = require("../../shared/config/cloudinary");
      const { Readable } = require("stream");

      const allowedMimeTypes = [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ];
      if (!allowedMimeTypes.includes(file.mimetype)) {
        throw new ApiError(400, "Only PDF and DOCX files are allowed");
      }

      typeLabel = file.mimetype === "application/pdf" ? "pdf" : "docx";

      const cloudinaryResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "admin-reports",
            public_id: `report-${adminUserId}-${Date.now()}`,
            resource_type: "raw",
            use_filename: true,
          },
          (error, result) => {
            if (error) return reject(new ApiError(500, "File upload failed"));
            resolve(result);
          },
        );
        const readable = new Readable();
        readable.push(file.buffer);
        readable.push(null);
        readable.pipe(uploadStream);
      });

      url = cloudinaryResult.secure_url;
      cloudinaryId = cloudinaryResult.public_id;
    }

    const report = await prisma.adminReport.create({
      data: {
        adminUser: {
          connect: { id: adminUserId },
        },
        title,
        body: body || null,
        note: note || null,
        type: typeLabel,
        url,
        cloudinaryId,
        createdBy: adminUserId,
      },
      select: {
        id: true,
        title: true,
        type: true,
        date: true,
        body: true,
        note: true,
        url: true,
      },
    });

    await createAuditLog({
      adminUserId,
      action: "PROFILE_UPDATED",
      targetId: report.id,
      targetType: "admin_report",
      metadata: {
        section: "reports",
        title,
        hasFile: !!(file && file.size > 0),
      },
      req,
    });

    await notificationService.createNotification({
      adminUserId,
      icon: "check",
      title: "Report Added",
      subtitle: `Your report "${title}" has been added successfully.`,
    });

    return report;
  }
  async getReportDownloadUrl({ adminUserId, reportId }) {
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
    if (!report.url) {
      throw new ApiError(404, "No file attached to this report");
    }

    return { url: report.url, name: report.title, type: report.type };
  }

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

  async updateReport({ adminUserId, reportId, file, title, body, note, req }) {
    const cloudinary = require("../../shared/config/cloudinary");
    const { Readable } = require("stream");

    const existing = await prisma.adminReport.findUnique({
      where: { id: reportId },
    });
    if (!existing) throw new ApiError(404, "Report not found");
    if (existing.adminUserId !== adminUserId)
      throw new ApiError(403, "Forbidden");

    let url = existing.url;
    let cloudinaryId = existing.cloudinaryId;
    let typeLabel = existing.type;

    // Handle file upload only if a new file is provided
    if (file && file.size > 0 && file.buffer) {
      const allowedMimeTypes = [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ];
      if (!allowedMimeTypes.includes(file.mimetype)) {
        throw new ApiError(400, "Only PDF and DOCX files are allowed");
      }

      // Delete old file from Cloudinary if it exists
      if (existing.cloudinaryId) {
        await cloudinary.uploader.destroy(existing.cloudinaryId, {
          resource_type: "raw",
        });
      }

      const cloudinaryResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "admin-reports",
            public_id: `report-${adminUserId}-${Date.now()}`,
            resource_type: "raw",
            use_filename: true,
          },
          (error, result) => {
            if (error) return reject(new ApiError(500, "File upload failed"));
            resolve(result);
          },
        );
        const readable = new Readable();
        readable.push(file.buffer);
        readable.push(null);
        readable.pipe(uploadStream);
      });

      url = cloudinaryResult.secure_url;
      cloudinaryId = cloudinaryResult.public_id;
      typeLabel = file.mimetype === "application/pdf" ? "pdf" : "docx";
    }

    const updated = await prisma.adminReport.update({
      where: { id: reportId },
      data: {
        title: title ?? existing.title,
        body: body !== undefined ? body : existing.body,
        note: note !== undefined ? note : existing.note,
        type: typeLabel,
        url,
        cloudinaryId,
      },
      select: {
        id: true,
        title: true,
        type: true,
        date: true,
        body: true,
        note: true,
        url: true,
      },
    });

    await createAuditLog({
      adminUserId,
      action: "PROFILE_UPDATED",
      targetId: reportId,
      targetType: "admin_report",
      metadata: {
        section: "reports",
        action: "update",
        hasFile: !!(file && file.size > 0),
      },
      req,
    });

    await notificationService.createNotification({
      adminUserId,
      icon: "check",
      title: "Report Updated",
      subtitle: `Your report "${updated.title}" has been updated.`,
    });

    return updated;
  }

  async deleteReport({ adminUserId, reportId, req }) {
    const cloudinary = require("../../shared/config/cloudinary");

    const existing = await prisma.adminReport.findUnique({
      where: { id: reportId },
    });
    if (!existing) throw new ApiError(404, "Report not found");
    if (existing.adminUserId !== adminUserId)
      throw new ApiError(403, "Forbidden");

    if (existing.cloudinaryId) {
      await cloudinary.uploader.destroy(existing.cloudinaryId, {
        resource_type: "raw",
      });
    }

    await prisma.adminReport.delete({ where: { id: reportId } });

    await createAuditLog({
      adminUserId,
      action: "PROFILE_UPDATED",
      targetId: reportId,
      targetType: "admin_report",
      metadata: { section: "reports", action: "delete" },
      req,
    });

    await notificationService.createNotification({
      adminUserId,
      icon: "alert",
      title: "Report Deleted",
      subtitle: `Your report "${existing.title}" has been deleted.`,
    });
  }

  async updateAvatar({ adminUserId, file, req }) {
    const cloudinary = require("../../shared/config/cloudinary");
    const { Readable } = require("stream");

    const MAX_FILE_SIZE = 1 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      throw new ApiError(400, `Avatar file size cannot exceed 1MB`);
    }

    const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new ApiError(400, "Only JPEG, PNG, and WEBP images are allowed");
    }

    const existing = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { avatarCloudinaryId: true },
    });

    const cloudinaryResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `admin-avatars`,
          public_id: `avatar-${adminUserId}`,
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

    await notificationService.createNotification({
      adminUserId,
      icon: "check",
      title: "Profile Picture Updated",
      subtitle: "Your profile picture has been changed successfully.",
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
      teamLead: project.team.members[0]?.adminUser.name ?? "",
      members: project.assignees.length,
    }));
  }

  async getMyProjectDetail({ adminUserId, projectId }) {
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

  _pick(obj, allowedKeys) {
    return Object.fromEntries(
      Object.entries(obj).filter(([key]) => allowedKeys.includes(key)),
    );
  }
}

module.exports = new ProfileService();
