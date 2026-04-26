-- AlterTable
ALTER TABLE "admin_reports" ALTER COLUMN "type" DROP NOT NULL,
ALTER COLUMN "type" SET DEFAULT 'text';
