const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const bcrypt = require("bcrypt");
require("dotenv").config();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SAMPLE_DOC = {
  url: "https://res.cloudinary.com/dgn3gfhlr/image/upload/v1776872219/sample-document_vdjuti.pdf",
  cloudinaryId: "sample-document_vdjuti",
};
const SAMPLE_NOTE = {
  url: "https://res.cloudinary.com/dgn3gfhlr/image/upload/v1776872435/sample-performance-note_dkabz1.pdf",
  cloudinaryId: "sample-performance-note_dkabz1",
};

const SUPER_ADMIN_ID = "bc92310e-d161-4287-9f59-8767630760be";
const SUPER_ADMIN_EMAIL = "cosmicforge.dev.team@gmail.com";

const DAVID_ID = "41408630-e8fb-4710-ace8-8472b8392299";
const DAVID_EMAIL = "davidodimayo44@gmail.com";

const PRECIOUS_ID = "5dceb19b-59f3-4c10-8a36-5d3af28c7afc";
const PRECIOUS_EMAIL = "Thepreciousesiri@gmail.com";

async function upsertSocialLinks(adminUserId, links) {
  await prisma.adminSocialLink.deleteMany({ where: { adminUserId } });
  await prisma.adminSocialLink.createMany({
    data: links.map((l) => ({ adminUserId, ...l })),
  });
}

async function upsertEducation(adminUserId, entries) {
  await prisma.adminEducation.deleteMany({ where: { adminUserId } });
  await prisma.adminEducation.createMany({
    data: entries.map((e) => ({ adminUserId, ...e })),
  });
}

async function seedDocumentsIfEmpty(adminUserId, uploadedBy, docs) {
  const existing = await prisma.adminDocument.count({ where: { adminUserId } });
  if (existing > 0) return;
  await prisma.adminDocument.createMany({
    data: docs.map((d) => ({ adminUserId, uploadedBy, ...d })),
  });
}

async function seedPerformanceNotesIfEmpty(adminUserId, createdBy, notes) {
  const existing = await prisma.adminPerformanceNote.count({
    where: { adminUserId },
  });
  if (existing > 0) return;
  await prisma.adminPerformanceNote.createMany({
    data: notes.map((n) => ({ adminUserId, createdBy, ...n })),
  });
}

async function seedReportsIfEmpty(adminUserId, reports) {
  const existing = await prisma.adminReport.count({ where: { adminUserId } });
  if (existing > 0) return;
  await prisma.adminReport.createMany({
    data: reports.map((r) => ({ adminUserId, createdBy: adminUserId, ...r })),
  });
}

async function seedNotificationsIfEmpty(adminUserId, notifications) {
  const existing = await prisma.notification.count({ where: { adminUserId } });
  if (existing > 0) return;
  await prisma.notification.createMany({
    data: notifications.map((n) => ({ adminUserId, ...n })),
  });
}

async function main() {
  console.log("🌱 Starting seed...\n");

  // ── 1. Super Admin ────────────────────────────────────────────────────────
  console.log("Updating Super Admin profile...");
  await prisma.adminUser.update({
    where: { id: SUPER_ADMIN_ID },
    data: {
      name: "Idowu Odimayo",
      position: "Chief Executive Officer",
      department: "MANAGEMENT",
      isTeamLead: true,
      preferredName: "Idowu",
      birthday: new Date("1988-03-10"),
      nationality: "Nigerian",
      gender: "Male",
      maritalStatus: "Married",
      workPhone: "+234-800-000-0001",
      homePhone: "+234-800-000-0002",
      personalPhone: "+234-800-000-0003",
      fax: "+234-1-000-0001",
      address: "12 Admiralty Way, Lekki Phase 1",
      state: "Lagos",
      country: "Nigeria",
      emergencyName: "Funmi Odimayo",
      emergencyPhone: "+234-800-000-0099",
      emergencyEmail: "funmi.odimayo@gmail.com",
      emergencyRelation: "Spouse",
      employmentType: "Full-time",
      employmentCategory: "Permanent",
      location: "Lagos, Nigeria",
      salary: 2500000.0,
      bonus: 500000.0,
      equity: 2.5,
    },
  });

  await upsertSocialLinks(SUPER_ADMIN_ID, [
    { platform: "LinkedIn", username: "idowuodimayo" },
    { platform: "Twitter", username: "@idowuodimayo" },
    { platform: "GitHub", username: "idowuodimayo" },
  ]);

  await upsertEducation(SUPER_ADMIN_ID, [
    {
      degreeTitle: "B.Sc. Computer Science",
      institution: "University of Lagos",
      from: "2006",
      to: "2010",
    },
    {
      degreeTitle: "MBA",
      institution: "Lagos Business School",
      from: "2013",
      to: "2015",
    },
  ]);

  await seedDocumentsIfEmpty(SUPER_ADMIN_ID, SUPER_ADMIN_ID, [
    {
      name: "Employment Contract",
      type: "pdf",
      url: SAMPLE_DOC.url,
      cloudinaryId: SAMPLE_DOC.cloudinaryId,
    },
    {
      name: "NDA Agreement",
      type: "pdf",
      url: SAMPLE_DOC.url,
      cloudinaryId: SAMPLE_DOC.cloudinaryId,
    },
  ]);

  await seedPerformanceNotesIfEmpty(SUPER_ADMIN_ID, SUPER_ADMIN_ID, [
    {
      title: "Q1 2026 Performance Review",
      type: "pdf",
      url: SAMPLE_NOTE.url,
      cloudinaryId: SAMPLE_NOTE.cloudinaryId,
    },
    {
      title: "Annual Appraisal 2025",
      type: "pdf",
      url: SAMPLE_NOTE.url,
      cloudinaryId: SAMPLE_NOTE.cloudinaryId,
    },
  ]);

  await seedReportsIfEmpty(SUPER_ADMIN_ID, [
    {
      title: "Q1 2026 Executive Summary",
      body: "This report summarises the key milestones achieved in Q1 2026. The team successfully launched the Centralized Admin platform, onboarded 12 new enterprise clients, and exceeded revenue targets by 18%.",
      note: "Approved by board on April 1, 2026.",
    },
    {
      title: "Leave Resumption — March 2026",
      body: "I hereby confirm my resumption from annual leave on March 3, 2026. All pending tasks have been handed back and I am fully resuming my duties.",
      note: null,
    },
  ]);

  await seedNotificationsIfEmpty(SUPER_ADMIN_ID, [
    {
      icon: "alert",
      title: "Welcome to the Admin Platform",
      subtitle: "Your super admin account is fully set up and ready.",
      isRead: false,
    },
    {
      icon: "check",
      title: "Profile updated successfully",
      subtitle: "All your profile fields have been populated.",
      isRead: true,
    },
  ]);

  console.log("✅ Super Admin updated.\n");

  // ── 2. David ──────────────────────────────────────────────────────────────
  console.log("Updating David profile...");
  await prisma.adminUser.update({
    where: { id: DAVID_ID },
    data: {
      name: "David Odimayo",
      position: "Customer Care Specialist",
      department: "CUSTOMER_CARE",
      isTeamLead: false,
      preferredName: "Dave",
      birthday: new Date("1995-06-15"),
      nationality: "Nigerian",
      gender: "Male",
      maritalStatus: "Single",
      workPhone: "+234-800-111-0001",
      homePhone: "+234-800-111-0002",
      personalPhone: "+234-800-111-0003",
      fax: "+234-1-000-0002",
      address: "45 Bode Thomas Street, Surulere",
      state: "Lagos",
      country: "Nigeria",
      emergencyName: "Grace Odimayo",
      emergencyPhone: "+234-800-111-0099",
      emergencyEmail: "grace.odimayo@gmail.com",
      emergencyRelation: "Sister",
      employmentType: "Full-time",
      employmentCategory: "Permanent",
      location: "Lagos, Nigeria",
      salary: 350000.0,
      bonus: 50000.0,
      equity: 0.0,
    },
  });

  await upsertSocialLinks(DAVID_ID, [
    { platform: "LinkedIn", username: "davidodimayo" },
    { platform: "Twitter", username: "@davidodimayo" },
  ]);

  await upsertEducation(DAVID_ID, [
    {
      degreeTitle: "B.Sc. Mass Communication",
      institution: "University of Ibadan",
      from: "2013",
      to: "2017",
    },
    {
      degreeTitle: "Customer Experience Certification",
      institution: "Coursera / HubSpot Academy",
      from: "2021",
      to: "2021",
    },
  ]);

  await seedDocumentsIfEmpty(DAVID_ID, SUPER_ADMIN_ID, [
    {
      name: "Employment Contract",
      type: "pdf",
      url: SAMPLE_DOC.url,
      cloudinaryId: SAMPLE_DOC.cloudinaryId,
    },
    {
      name: "Offer Letter",
      type: "pdf",
      url: SAMPLE_DOC.url,
      cloudinaryId: SAMPLE_DOC.cloudinaryId,
    },
  ]);

  await seedPerformanceNotesIfEmpty(DAVID_ID, SUPER_ADMIN_ID, [
    {
      title: "Q1 2026 Performance Review",
      type: "pdf",
      url: SAMPLE_NOTE.url,
      cloudinaryId: SAMPLE_NOTE.cloudinaryId,
    },
    {
      title: "Probation Assessment — Oct 2025",
      type: "pdf",
      url: SAMPLE_NOTE.url,
      cloudinaryId: SAMPLE_NOTE.cloudinaryId,
    },
  ]);

  await seedReportsIfEmpty(DAVID_ID, [
    {
      title: "Leave Resumption — April 2026",
      body: "I hereby confirm my resumption from annual leave on April 7, 2026. I have been briefed on all pending tickets and am fully resuming my support duties.",
      note: null,
    },
    {
      title: "Monthly Milestone — March 2026",
      body: "During March 2026, I resolved 142 support tickets with an average response time of 2.3 hours. Customer satisfaction score for the month stood at 94%.",
      note: "Submitted for team lead review.",
    },
  ]);

  await seedNotificationsIfEmpty(DAVID_ID, [
    {
      icon: "alert",
      title: "New ticket assigned to you",
      subtitle: "Ticket #TKT-00234 has been assigned by Idowu Odimayo.",
      isRead: false,
    },
    {
      icon: "check",
      title: "Your leave request was approved",
      subtitle: "Annual leave from Apr 1–6, 2026 has been approved.",
      isRead: false,
    },
    {
      icon: "bell",
      title: "Profile setup complete",
      subtitle: "All your profile details have been filled in.",
      isRead: true,
    },
  ]);

  console.log("✅ David updated.\n");

  // ── 3. Precious ───────────────────────────────────────────────────────────
  console.log("Updating Precious profile...");
  await prisma.adminUser.update({
    where: { id: PRECIOUS_ID },
    data: {
      name: "Precious Esiri",
      position: "Customer Care Specialist",
      department: "CUSTOMER_CARE",
      isTeamLead: false,
      preferredName: "Precious",
      birthday: new Date("1997-09-20"),
      nationality: "Nigerian",
      gender: "Female",
      maritalStatus: "Single",
      workPhone: "+234-800-222-0001",
      homePhone: "+234-800-222-0002",
      personalPhone: "+234-800-222-0003",
      fax: "+234-1-000-0003",
      address: "10 Ogunnusi Road, Ojodu",
      state: "Lagos",
      country: "Nigeria",
      emergencyName: "Mrs Esiri",
      emergencyPhone: "+234-800-222-0099",
      emergencyEmail: "esiri.family@gmail.com",
      emergencyRelation: "Mother",
      employmentType: "Full-time",
      employmentCategory: "Permanent",
      location: "Lagos, Nigeria",
      salary: 350000.0,
      bonus: 50000.0,
      equity: 0.0,
    },
  });

  await upsertSocialLinks(PRECIOUS_ID, [
    { platform: "LinkedIn", username: "preciousesiri" },
    { platform: "Twitter", username: "@preciousesiri" },
  ]);

  await upsertEducation(PRECIOUS_ID, [
    {
      degreeTitle: "B.Sc. Business Administration",
      institution: "University of Benin",
      from: "2015",
      to: "2019",
    },
    {
      degreeTitle: "Customer Service Certification",
      institution: "Coursera",
      from: "2022",
      to: "2022",
    },
  ]);

  await seedDocumentsIfEmpty(PRECIOUS_ID, SUPER_ADMIN_ID, [
    {
      name: "Employment Contract",
      type: "pdf",
      url: SAMPLE_DOC.url,
      cloudinaryId: SAMPLE_DOC.cloudinaryId,
    },
    {
      name: "Offer Letter",
      type: "pdf",
      url: SAMPLE_DOC.url,
      cloudinaryId: SAMPLE_DOC.cloudinaryId,
    },
  ]);

  await seedPerformanceNotesIfEmpty(PRECIOUS_ID, SUPER_ADMIN_ID, [
    {
      title: "Q1 2026 Performance Review",
      type: "pdf",
      url: SAMPLE_NOTE.url,
      cloudinaryId: SAMPLE_NOTE.cloudinaryId,
    },
    {
      title: "Probation Assessment — Jan 2026",
      type: "pdf",
      url: SAMPLE_NOTE.url,
      cloudinaryId: SAMPLE_NOTE.cloudinaryId,
    },
  ]);

  await seedReportsIfEmpty(PRECIOUS_ID, [
    {
      title: "Monthly Milestone — March 2026",
      body: "During March 2026, I handled 98 support tickets with an average response time of 2.8 hours. Customer satisfaction score stood at 91%.",
      note: "Submitted for team lead review.",
    },
    {
      title: "Leave Resumption — April 2026",
      body: "I hereby confirm my resumption from annual leave on April 7, 2026. I have been briefed on all pending tickets and am fully resuming my support duties.",
      note: null,
    },
  ]);

  await seedNotificationsIfEmpty(PRECIOUS_ID, [
    {
      icon: "alert",
      title: "New ticket assigned to you",
      subtitle: "Ticket #TKT-00235 has been assigned by Idowu Odimayo.",
      isRead: false,
    },
    {
      icon: "bell",
      title: "Profile setup complete",
      subtitle: "All your profile details have been filled in.",
      isRead: true,
    },
  ]);

  console.log("✅ Precious updated.\n");

  // ── 4. Seed Team ──────────────────────────────────────────────────────────
  console.log("Seeding Customer Care Team...");
  let team = await prisma.team.findFirst({
    where: { title: "Customer Care Team" },
  });

  if (!team) {
    team = await prisma.team.create({
      data: {
        title: "Customer Care Team",
        department: "CUSTOMER_CARE",
        createdBy: SUPER_ADMIN_ID,
      },
    });
    console.log("✅ Team created.");
  } else {
    console.log("⏭️  Team already exists — skipping.");
  }

  // ── 5. Seed Team Members ──────────────────────────────────────────────────
  await prisma.teamMember.upsert({
    where: {
      teamId_adminUserId: { teamId: team.id, adminUserId: SUPER_ADMIN_ID },
    },
    update: {},
    create: { teamId: team.id, adminUserId: SUPER_ADMIN_ID, isTeamLead: true },
  });
  await prisma.teamMember.upsert({
    where: { teamId_adminUserId: { teamId: team.id, adminUserId: DAVID_ID } },
    update: {},
    create: { teamId: team.id, adminUserId: DAVID_ID, isTeamLead: false },
  });
  await prisma.teamMember.upsert({
    where: {
      teamId_adminUserId: { teamId: team.id, adminUserId: PRECIOUS_ID },
    },
    update: {},
    create: { teamId: team.id, adminUserId: PRECIOUS_ID, isTeamLead: false },
  });
  console.log("✅ Team members seeded.\n");

  // ── 6. Seed Project ───────────────────────────────────────────────────────
  console.log("Seeding Project...");
  let project = await prisma.project.findFirst({
    where: { title: "Centralized Admin Platform" },
  });

  if (!project) {
    project = await prisma.project.create({
      data: {
        title: "Centralized Admin Platform",
        description:
          "Build and maintain the internal centralized admin dashboard for all departments.",
        assignedDate: new Date("2025-09-25"),
        dueDate: new Date("2026-06-30"),
        teamId: team.id,
        status: "IN_PROGRESS",
        createdBy: SUPER_ADMIN_ID,
      },
    });
    console.log("✅ Project created.");
  } else {
    console.log("⏭️  Project already exists — skipping.");
  }

  // ── 7. Seed Project Members ───────────────────────────────────────────────
  await prisma.projectMember.upsert({
    where: {
      projectId_adminUserId: {
        projectId: project.id,
        adminUserId: SUPER_ADMIN_ID,
      },
    },
    update: {},
    create: { projectId: project.id, adminUserId: SUPER_ADMIN_ID },
  });
  await prisma.projectMember.upsert({
    where: {
      projectId_adminUserId: { projectId: project.id, adminUserId: DAVID_ID },
    },
    update: {},
    create: { projectId: project.id, adminUserId: DAVID_ID },
  });
  await prisma.projectMember.upsert({
    where: {
      projectId_adminUserId: {
        projectId: project.id,
        adminUserId: PRECIOUS_ID,
      },
    },
    update: {},
    create: { projectId: project.id, adminUserId: PRECIOUS_ID },
  });
  console.log("✅ Project members seeded.\n");

  // ── 8. Seed Tasks ─────────────────────────────────────────────────────────
  console.log("Seeding Tasks...");
  const davidTask = await prisma.task.findFirst({
    where: { assigneeId: DAVID_ID, title: "Handle onboarding support tickets" },
  });

  if (!davidTask) {
    await prisma.task.create({
      data: {
        title: "Handle onboarding support tickets",
        description:
          "Review and resolve all pending onboarding-related support tickets submitted by new users on the platform.",
        assignedDate: new Date("2026-04-01"),
        dueDate: new Date("2026-04-30"),
        projectId: project.id,
        assignerId: SUPER_ADMIN_ID,
        assigneeId: DAVID_ID,
        status: "IN_PROGRESS",
      },
    });
    console.log("✅ David task created.");
  } else {
    console.log("⏭️  David task already exists — skipping.");
  }

  const preciousTask = await prisma.task.findFirst({
    where: {
      assigneeId: PRECIOUS_ID,
      title: "Handle onboarding support tickets",
    },
  });

  if (!preciousTask) {
    await prisma.task.create({
      data: {
        title: "Handle onboarding support tickets",
        description:
          "Review and resolve all pending onboarding-related support tickets submitted by new users on the platform.",
        assignedDate: new Date("2026-04-01"),
        dueDate: new Date("2026-04-30"),
        projectId: project.id,
        assignerId: SUPER_ADMIN_ID,
        assigneeId: PRECIOUS_ID,
        status: "IN_PROGRESS",
      },
    });
    console.log("✅ Precious task created.");
  } else {
    console.log("⏭️  Precious task already exists — skipping.");
  }

  console.log("\n🎉 Seed complete! All users are fully populated.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
