-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('SICK', 'ANNUAL', 'EMERGENCY', 'MATERNITY', 'PATERNITY', 'UNPAID', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'HRM_ATTENDANCE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'HRM_ATTENDANCE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'HRM_LEAVE_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'HRM_LEAVE_DENIED';
ALTER TYPE "AuditAction" ADD VALUE 'HRM_LEAVE_APPROVE_ALL';

-- CreateTable
CREATE TABLE "AttendanceLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "clockIn" TIMESTAMP(3),
    "clockOut" TIMESTAMP(3),
    "status" "AttendanceStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "leaveType" "LeaveType" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "resumptionDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "attachmentUrl" TEXT,
    "attachmentName" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveBalance" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "leaveType" "LeaveType" NOT NULL,
    "year" INTEGER NOT NULL,
    "availableDays" INTEGER NOT NULL DEFAULT 0,
    "usedDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceLog_adminUserId_idx" ON "AttendanceLog"("adminUserId");

-- CreateIndex
CREATE INDEX "AttendanceLog_date_idx" ON "AttendanceLog"("date");

-- CreateIndex
CREATE INDEX "AttendanceLog_status_idx" ON "AttendanceLog"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceLog_adminUserId_date_key" ON "AttendanceLog"("adminUserId", "date");

-- CreateIndex
CREATE INDEX "LeaveRequest_adminUserId_idx" ON "LeaveRequest"("adminUserId");

-- CreateIndex
CREATE INDEX "LeaveRequest_status_idx" ON "LeaveRequest"("status");

-- CreateIndex
CREATE INDEX "LeaveRequest_startDate_idx" ON "LeaveRequest"("startDate");

-- CreateIndex
CREATE INDEX "LeaveRequest_reviewedById_idx" ON "LeaveRequest"("reviewedById");

-- CreateIndex
CREATE INDEX "LeaveBalance_adminUserId_idx" ON "LeaveBalance"("adminUserId");

-- CreateIndex
CREATE INDEX "LeaveBalance_year_idx" ON "LeaveBalance"("year");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveBalance_adminUserId_leaveType_year_key" ON "LeaveBalance"("adminUserId", "leaveType", "year");

-- AddForeignKey
ALTER TABLE "AttendanceLog" ADD CONSTRAINT "AttendanceLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
