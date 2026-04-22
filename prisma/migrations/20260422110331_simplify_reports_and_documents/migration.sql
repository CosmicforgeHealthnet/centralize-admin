/*
  Warnings:

  - You are about to drop the column `cloudinaryId` on the `admin_reports` table. All the data in the column will be lost.
  - You are about to drop the column `url` on the `admin_reports` table. All the data in the column will be lost.
  - Added the required column `uploadedBy` to the `admin_documents` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "admin_documents" ADD COLUMN     "uploadedBy" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "admin_performance_notes" ADD COLUMN     "cloudinaryId" TEXT;

-- AlterTable
ALTER TABLE "admin_reports" DROP COLUMN "cloudinaryId",
DROP COLUMN "url";
