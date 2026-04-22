/*
  Warnings:

  - A unique constraint covering the columns `[mainAppUserId]` on the table `admin_users` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "mainAppUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_mainAppUserId_key" ON "admin_users"("mainAppUserId");
