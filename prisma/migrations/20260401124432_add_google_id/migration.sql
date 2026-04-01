/*
  Warnings:

  - A unique constraint covering the columns `[googleId]` on the table `admin_users` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "googleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_googleId_key" ON "admin_users"("googleId");
