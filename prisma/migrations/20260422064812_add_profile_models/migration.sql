-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PROFILE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_UPLOADED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_DELETED';

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "address" TEXT,
ADD COLUMN     "birthday" TIMESTAMP(3),
ADD COLUMN     "bonus" DECIMAL(15,2),
ADD COLUMN     "country" TEXT,
ADD COLUMN     "emergencyEmail" TEXT,
ADD COLUMN     "emergencyName" TEXT,
ADD COLUMN     "emergencyPhone" TEXT,
ADD COLUMN     "emergencyRelation" TEXT,
ADD COLUMN     "equity" DECIMAL(15,2),
ADD COLUMN     "fax" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "homePhone" TEXT,
ADD COLUMN     "maritalStatus" TEXT,
ADD COLUMN     "nationality" TEXT,
ADD COLUMN     "personalPhone" TEXT,
ADD COLUMN     "preferredName" TEXT,
ADD COLUMN     "salary" DECIMAL(15,2),
ADD COLUMN     "state" TEXT,
ADD COLUMN     "workPhone" TEXT;

-- CreateTable
CREATE TABLE "admin_social_links" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_social_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_educations" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "degreeTitle" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "from" TEXT,
    "to" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_educations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_documents" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_performance_notes" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'docx',
    "url" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_performance_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_reports" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'docx',
    "url" TEXT NOT NULL,
    "body" TEXT,
    "createdBy" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_reports_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "admin_social_links" ADD CONSTRAINT "admin_social_links_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_educations" ADD CONSTRAINT "admin_educations_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_documents" ADD CONSTRAINT "admin_documents_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_performance_notes" ADD CONSTRAINT "admin_performance_notes_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_reports" ADD CONSTRAINT "admin_reports_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
