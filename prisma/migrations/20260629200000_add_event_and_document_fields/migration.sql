-- Add title and expiryDate fields to admin_documents
ALTER TABLE "admin_documents" ADD COLUMN "title" TEXT;
ALTER TABLE "admin_documents" ADD COLUMN "expiryDate" TIMESTAMP(3);

-- Create events table
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "time" TEXT NOT NULL,
    "location" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- Add HRM payroll and hiring audit actions to AuditAction enum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HRM_PAYROLL_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HRM_VACANCY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HRM_VACANCY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HRM_VACANCY_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HRM_VACANCY_STATUS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HRM_APPLICANT_STAGE_UPDATED';
