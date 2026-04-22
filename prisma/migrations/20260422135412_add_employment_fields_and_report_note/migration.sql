-- AlterTable
ALTER TABLE "admin_reports" ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "employmentCategory" TEXT,
ADD COLUMN     "employmentType" TEXT,
ADD COLUMN     "location" TEXT;
