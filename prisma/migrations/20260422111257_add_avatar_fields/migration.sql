-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'AVATAR_UPDATED';

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "avatarCloudinaryId" TEXT,
ADD COLUMN     "avatarUrl" TEXT;
