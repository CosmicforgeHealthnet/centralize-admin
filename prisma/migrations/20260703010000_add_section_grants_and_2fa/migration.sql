-- CreateEnum
CREATE TYPE "SectionAccessMode" AS ENUM ('VIEW', 'EDIT');

-- AlterEnum
ALTER TYPE "Department" ADD VALUE 'HR';
ALTER TYPE "Department" ADD VALUE 'VERIFICATION';
ALTER TYPE "Department" ADD VALUE 'RTC';
ALTER TYPE "Department" ADD VALUE 'TELEMEDICINE';
ALTER TYPE "Department" ADD VALUE 'OPERATIONS';

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'SECTION_GRANT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SECTION_GRANT_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'EMERGENCY_OVERRIDE_USED';

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "admin_users" ADD COLUMN "twoFactorSecret" TEXT;

-- CreateTable
CREATE TABLE "admin_section_grants" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "mode" "SectionAccessMode" NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "admin_section_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_section_grants_adminUserId_idx" ON "admin_section_grants"("adminUserId");

-- CreateIndex
CREATE INDEX "admin_section_grants_module_section_idx" ON "admin_section_grants"("module", "section");

-- AddForeignKey
ALTER TABLE "admin_section_grants" ADD CONSTRAINT "admin_section_grants_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
