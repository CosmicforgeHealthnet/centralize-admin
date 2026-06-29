-- Add HRM_EVENT_CREATED audit action to AuditAction enum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HRM_EVENT_CREATED';
