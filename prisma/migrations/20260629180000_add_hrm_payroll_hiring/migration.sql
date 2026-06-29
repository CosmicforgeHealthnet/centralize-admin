-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('PAID', 'PENDING');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PAID', 'PENDING', 'OVERDUE');

-- CreateEnum
CREATE TYPE "VacancyStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'CLOSED');

-- CreateEnum
CREATE TYPE "ApplicantStage" AS ENUM ('SCREENING', 'INTERVIEW', 'HIRED', 'REJECTED');

-- CreateTable
CREATE TABLE "payroll_records" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "totalSalary" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "totalAllowance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "totalBonus" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "grossPay" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "status" "PayrollStatus" NOT NULL DEFAULT 'PENDING',
    "paymentMethod" TEXT,
    "bankName" TEXT,
    "bankAccount" TEXT,
    "paymentDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "payrollRecordId" TEXT,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "basicSalary" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "allowance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "bonus" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "deductionsJson" JSONB,
    "netPay" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "paymentMethod" TEXT,
    "paymentDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deductions" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "payrollRecordId" TEXT,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "payrollRecordId" TEXT,
    "amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "payrollRecordId" TEXT,
    "amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_vacancies" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" "Department",
    "category" TEXT,
    "location" TEXT,
    "numberOfOpening" INTEGER NOT NULL DEFAULT 1,
    "experienceLevel" TEXT,
    "salaryRange" TEXT,
    "benefitsAndBonus" TEXT,
    "jobDescription" TEXT,
    "responsibilities" TEXT,
    "requirements" TEXT,
    "hiringStages" JSONB,
    "assignedRecruiter" TEXT,
    "deadline" TIMESTAMP(3),
    "status" "VacancyStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_vacancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_applicants" (
    "id" TEXT NOT NULL,
    "vacancyId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "stage" "ApplicantStage" NOT NULL DEFAULT 'SCREENING',
    "via" TEXT,
    "applicationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "coverLetter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_applicants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_applicant_attachments" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT,
    "type" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_applicant_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_records_adminUserId_month_year_key" ON "payroll_records"("adminUserId", "month", "year");

-- CreateIndex
CREATE INDEX "payroll_records_adminUserId_idx" ON "payroll_records"("adminUserId");

-- CreateIndex
CREATE INDEX "payroll_records_month_year_idx" ON "payroll_records"("month", "year");

-- CreateIndex
CREATE INDEX "payroll_records_status_idx" ON "payroll_records"("status");

-- CreateIndex
CREATE INDEX "payslips_adminUserId_idx" ON "payslips"("adminUserId");

-- CreateIndex
CREATE INDEX "payslips_month_year_idx" ON "payslips"("month", "year");

-- CreateIndex
CREATE INDEX "deductions_adminUserId_idx" ON "deductions"("adminUserId");

-- CreateIndex
CREATE INDEX "deductions_month_year_idx" ON "deductions"("month", "year");

-- CreateIndex
CREATE INDEX "receipts_adminUserId_idx" ON "receipts"("adminUserId");

-- CreateIndex
CREATE INDEX "receipts_month_year_idx" ON "receipts"("month", "year");

-- CreateIndex
CREATE INDEX "invoices_adminUserId_idx" ON "invoices"("adminUserId");

-- CreateIndex
CREATE INDEX "invoices_month_year_idx" ON "invoices"("month", "year");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "job_vacancies_status_idx" ON "job_vacancies"("status");

-- CreateIndex
CREATE INDEX "job_vacancies_department_idx" ON "job_vacancies"("department");

-- CreateIndex
CREATE INDEX "job_applicants_vacancyId_idx" ON "job_applicants"("vacancyId");

-- CreateIndex
CREATE INDEX "job_applicants_stage_idx" ON "job_applicants"("stage");

-- CreateIndex
CREATE INDEX "job_applicant_attachments_applicantId_idx" ON "job_applicant_attachments"("applicantId");

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "payroll_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "payroll_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "payroll_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "payroll_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applicants" ADD CONSTRAINT "job_applicants_vacancyId_fkey" FOREIGN KEY ("vacancyId") REFERENCES "job_vacancies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applicant_attachments" ADD CONSTRAINT "job_applicant_attachments_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "job_applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
