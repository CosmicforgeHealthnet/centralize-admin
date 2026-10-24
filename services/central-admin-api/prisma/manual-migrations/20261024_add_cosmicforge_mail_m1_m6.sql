-- CosmicForge Mail M1-M6 foundation (additive only).
-- Creates Mail identity, mailbox, transport, governance and Marketing Email
-- Studio tables in the Admin database. No existing table, column or type is
-- modified. Apply only through the reviewed staging runbook:
-- docs/cosmicforge-mail-staging-migration-runbook.md
-- Rollback: see the runbook (separate reviewed script; never automatic).

-- CreateEnum
CREATE TYPE "MailOrganizationKind" AS ENUM ('COMPANY', 'BRAND');

-- CreateEnum
CREATE TYPE "MailRecordStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MailDomainStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'FAILED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MailCapabilityStatus" AS ENUM ('NOT_CONFIGURED', 'PENDING', 'VERIFIED', 'FAILED', 'DISABLED');

-- CreateEnum
CREATE TYPE "MailAddressKind" AS ENUM ('PRIMARY', 'ALIAS', 'SHARED', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MailAddressStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "MailMailboxType" AS ENUM ('PERSONAL', 'SHARED');

-- CreateEnum
CREATE TYPE "MailMailboxPurpose" AS ENUM ('GENERAL', 'SUPPORT', 'MARKETING');

-- CreateEnum
CREATE TYPE "MailMembershipRole" AS ENUM ('OWNER', 'MANAGER', 'MEMBER', 'READER');

-- CreateEnum
CREATE TYPE "MailProvisionRequestType" AS ENUM ('PERSONAL_MAILBOX', 'SHARED_MAILBOX', 'ALIAS', 'SENDER_GRANT');

-- CreateEnum
CREATE TYPE "MailProvisionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'PROVISIONED');

-- CreateEnum
CREATE TYPE "MailMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');

-- CreateEnum
CREATE TYPE "MailMessageStatus" AS ENUM ('QUEUED', 'PROVIDER_ACCEPTED', 'DELIVERED', 'DELAYED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'RECEIVED', 'QUARANTINED', 'OUTCOME_UNKNOWN');

-- CreateEnum
CREATE TYPE "MailRecipientType" AS ENUM ('TO', 'CC', 'BCC');

-- CreateEnum
CREATE TYPE "MailRecipientStatus" AS ENUM ('PENDING', 'PROVIDER_ACCEPTED', 'DELIVERED', 'DELAYED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'INTERNAL_DELIVERED', 'OUTCOME_UNKNOWN');

-- CreateEnum
CREATE TYPE "MailThreadFolder" AS ENUM ('INBOX', 'ARCHIVE', 'TRASH', 'SPAM');

-- CreateEnum
CREATE TYPE "MailConversationStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MailDraftMode" AS ENUM ('NEW', 'REPLY', 'REPLY_ALL', 'FORWARD');

-- CreateEnum
CREATE TYPE "MailDraftStatus" AS ENUM ('ACTIVE', 'SENDING', 'SENT', 'DISCARDED');

-- CreateEnum
CREATE TYPE "MailAttachmentScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SCAN_FAILED', 'SCANNER_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "MailJobQueue" AS ENUM ('OUTBOUND', 'INBOUND', 'EVENTS');

-- CreateEnum
CREATE TYPE "MailJobStatus" AS ENUM ('PENDING', 'LEASED', 'RETRY_SCHEDULED', 'RECONCILING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MailWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "MailDeliveryEventType" AS ENUM ('SENT', 'DELIVERED', 'DELIVERY_DELAYED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'OPENED', 'CLICKED');

-- CreateEnum
CREATE TYPE "MailRetentionAction" AS ENUM ('ARCHIVE', 'DELETE');

-- CreateEnum
CREATE TYPE "MailBreakGlassStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MarketingContactStatus" AS ENUM ('ACTIVE', 'UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "MarketingConsentStatus" AS ENUM ('PENDING_CONFIRMATION', 'GRANTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "MarketingConsentSource" AS ENUM ('WEB_FORM', 'IMPORT', 'MANUAL', 'API', 'EVENT');

-- CreateEnum
CREATE TYPE "MarketingSuppressionReason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'MANUAL', 'LEGAL');

-- CreateEnum
CREATE TYPE "MarketingEmailCampaignStatus" AS ENUM ('DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'QUEUED', 'SENDING', 'COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MarketingCampaignApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "MarketingCampaignSnapshotKind" AS ENUM ('SUBMISSION', 'APPROVAL');

-- CreateTable
CREATE TABLE "mail_organizations" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "kind" "MailOrganizationKind" NOT NULL DEFAULT 'BRAND',
    "status" "MailRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_domains" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "status" "MailDomainStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "sending_status" "MailCapabilityStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "receiving_status" "MailCapabilityStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "provider" VARCHAR(32) NOT NULL DEFAULT 'resend',
    "provider_domain_id" VARCHAR(128),
    "dns_records" JSONB,
    "last_checked_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_mailboxes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" "MailMailboxType" NOT NULL,
    "purpose" "MailMailboxPurpose" NOT NULL DEFAULT 'GENERAL',
    "name" VARCHAR(160) NOT NULL,
    "owner_admin_user_id" TEXT,
    "status" "MailRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "signature_html" TEXT,
    "daily_send_quota" INTEGER NOT NULL DEFAULT 500,
    "sla_first_response_minutes" INTEGER,
    "support_ticket_link_enabled" BOOLEAN NOT NULL DEFAULT false,
    "suspended_at" TIMESTAMPTZ(6),
    "offboarded_at" TIMESTAMPTZ(6),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_addresses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "mailbox_id" UUID,
    "local_part" VARCHAR(64) NOT NULL,
    "address" VARCHAR(320) NOT NULL,
    "display_name" VARCHAR(160),
    "kind" "MailAddressKind" NOT NULL,
    "status" "MailAddressStatus" NOT NULL DEFAULT 'PENDING',
    "alias_of_address_id" UUID,
    "created_by" TEXT,
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_memberships" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "role" "MailMembershipRole" NOT NULL,
    "can_send" BOOLEAN NOT NULL DEFAULT false,
    "granted_by" TEXT,
    "reason" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_sender_grants" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "granted_by" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_sender_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_provision_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" "MailProvisionRequestType" NOT NULL,
    "status" "MailProvisionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_admin_user_id" TEXT NOT NULL,
    "subject_admin_user_id" TEXT,
    "requested_address" VARCHAR(320),
    "mailbox_id" UUID,
    "payload" JSONB,
    "justification" TEXT,
    "reviewed_by_admin_user_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "provisioned_address_id" UUID,
    "provisioned_mailbox_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_provision_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_threads" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "subject" VARCHAR(998) NOT NULL DEFAULT '',
    "normalized_subject" VARCHAR(998) NOT NULL DEFAULT '',
    "root_rfc_message_id" VARCHAR(998),
    "folder" "MailThreadFolder" NOT NULL DEFAULT 'INBOX',
    "has_inbound" BOOLEAN NOT NULL DEFAULT false,
    "has_outbound" BOOLEAN NOT NULL DEFAULT false,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "encrypted_snippet" BYTEA,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_inbound_at" TIMESTAMPTZ(6),
    "participants" JSONB,
    "conversation_status" "MailConversationStatus",
    "assigned_to_admin_user_id" TEXT,
    "assigned_at" TIMESTAMPTZ(6),
    "sla_due_at" TIMESTAMPTZ(6),
    "first_response_at" TIMESTAMPTZ(6),
    "locked_by_admin_user_id" TEXT,
    "lock_expires_at" TIMESTAMPTZ(6),
    "support_ticket_ref" VARCHAR(128),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_messages" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "direction" "MailMessageDirection" NOT NULL,
    "status" "MailMessageStatus" NOT NULL,
    "rfc_message_id" VARCHAR(998) NOT NULL,
    "in_reply_to" VARCHAR(998),
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" VARCHAR(998) NOT NULL DEFAULT '',
    "encrypted_snippet" BYTEA,
    "from_address" VARCHAR(320) NOT NULL,
    "from_name" VARCHAR(320),
    "reply_to" VARCHAR(320),
    "sender_address_id" UUID,
    "sent_by_admin_user_id" TEXT,
    "envelope_recipient" VARCHAR(320),
    "has_attachments" BOOLEAN NOT NULL DEFAULT false,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "content_object_key" VARCHAR(512),
    "content_sha256" CHAR(64),
    "raw_mime_object_key" VARCHAR(512),
    "metadata_search_text" TEXT NOT NULL DEFAULT '',
    "provider_message_id" VARCHAR(255),
    "idempotency_key" VARCHAR(128),
    "auth_results" JSONB,
    "spam_verdict" VARCHAR(32),
    "quarantine_reason" VARCHAR(255),
    "last_status_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_message_recipients" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "type" "MailRecipientType" NOT NULL,
    "address" VARCHAR(320) NOT NULL,
    "name" VARCHAR(320),
    "status" "MailRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "last_event_at" TIMESTAMPTZ(6),
    "last_event_detail" VARCHAR(500),
    "provider_message_id" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_message_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_user_thread_states" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "last_read_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_user_thread_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_drafts" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "author_admin_user_id" TEXT NOT NULL,
    "sender_address_id" UUID,
    "thread_id" UUID,
    "in_reply_to_message_id" UUID,
    "mode" "MailDraftMode" NOT NULL DEFAULT 'NEW',
    "status" "MailDraftStatus" NOT NULL DEFAULT 'ACTIVE',
    "to_recipients" JSONB NOT NULL DEFAULT '[]',
    "cc_recipients" JSONB NOT NULL DEFAULT '[]',
    "bcc_recipients" JSONB NOT NULL DEFAULT '[]',
    "subject" VARCHAR(998) NOT NULL DEFAULT '',
    "encrypted_body" BYTEA,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "sent_message_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_labels" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "color" VARCHAR(16),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_thread_labels" (
    "thread_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK_mail_thread_labels" PRIMARY KEY ("thread_id","label_id")
);

-- CreateTable
CREATE TABLE "mail_rules" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_attachments" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "message_id" UUID,
    "draft_id" UUID,
    "filename" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(255) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storage_key" VARCHAR(512),
    "is_inline" BOOLEAN NOT NULL DEFAULT false,
    "content_id" VARCHAR(255),
    "scan_status" "MailAttachmentScanStatus" NOT NULL DEFAULT 'PENDING',
    "scan_detail" VARCHAR(255),
    "quarantined" BOOLEAN NOT NULL DEFAULT true,
    "uploaded_by_admin_user_id" TEXT,
    "provider_attachment_id" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_internal_notes" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "author_admin_user_id" TEXT NOT NULL,
    "encrypted_body" BYTEA NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "mail_internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_outbox_jobs" (
    "id" UUID NOT NULL,
    "queue" "MailJobQueue" NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "status" "MailJobStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" VARCHAR(160) NOT NULL,
    "message_id" UUID,
    "webhook_event_id" UUID,
    "payload" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 6,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "last_error_message" VARCHAR(500),
    "provider_request_id" VARCHAR(255),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_outbox_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_event_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "signature_verified" BOOLEAN NOT NULL,
    "status" "MailWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(500),

    CONSTRAINT "mail_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_delivery_events" (
    "id" UUID NOT NULL,
    "message_id" UUID,
    "webhook_event_id" UUID,
    "provider_message_id" VARCHAR(255) NOT NULL,
    "recipient" VARCHAR(320),
    "event_type" "MailDeliveryEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_audit_events" (
    "id" UUID NOT NULL,
    "actor_admin_user_id" TEXT,
    "action" VARCHAR(80) NOT NULL,
    "target_type" VARCHAR(64) NOT NULL,
    "target_id" VARCHAR(128),
    "mailbox_id" UUID,
    "organization_id" UUID,
    "outcome" VARCHAR(16) NOT NULL DEFAULT 'SUCCESS',
    "metadata" JSONB,
    "request_id" VARCHAR(128),
    "ip_address" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_retention_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mailbox_id" UUID,
    "name" VARCHAR(160) NOT NULL,
    "retain_days" INTEGER NOT NULL,
    "action" "MailRetentionAction" NOT NULL DEFAULT 'ARCHIVE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_legal_holds" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mailbox_id" UUID,
    "subject_admin_user_id" TEXT,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_step_up_verifications" (
    "id" UUID NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "purpose" VARCHAR(64) NOT NULL,
    "verified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "totp_counter" BIGINT,
    "ip_address" VARCHAR(64),

    CONSTRAINT "mail_step_up_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_break_glass_requests" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "requester_admin_user_id" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "case_reference" VARCHAR(128) NOT NULL,
    "status" "MailBreakGlassStatus" NOT NULL DEFAULT 'PENDING',
    "requester_step_up_id" UUID NOT NULL,
    "approver_admin_user_id" TEXT,
    "approver_step_up_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "access_expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_break_glass_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_contacts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "first_name" VARCHAR(120),
    "last_name" VARCHAR(120),
    "attributes" JSONB,
    "status" "MarketingContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" VARCHAR(64) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_email_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_consents" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "topic" VARCHAR(64) NOT NULL,
    "status" "MarketingConsentStatus" NOT NULL,
    "source" "MarketingConsentSource" NOT NULL,
    "source_evidence" JSONB NOT NULL,
    "policy_version" VARCHAR(32) NOT NULL,
    "double_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "confirmation_token_hash" CHAR(64),
    "consented_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawal_source" VARCHAR(64),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_email_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_suppressions" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "email" VARCHAR(320) NOT NULL,
    "reason" "MarketingSuppressionReason" NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMPTZ(6),
    "lifted_by" TEXT,

    CONSTRAINT "marketing_email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_audiences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "topic" VARCHAR(64) NOT NULL,
    "status" "MailRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_email_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_audience_contacts" (
    "audience_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "added_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK_marketing_audience_contacts" PRIMARY KEY ("audience_id","contact_id")
);

-- CreateTable
CREATE TABLE "marketing_email_segments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "audience_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "definition" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_email_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_studio_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "status" "MailRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "latest_version" INTEGER NOT NULL DEFAULT 0,
    "legacy_template_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_email_studio_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" VARCHAR(998) NOT NULL,
    "preheader" VARCHAR(255),
    "blocks" JSONB NOT NULL,
    "brand" JSONB,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "content_sha256" CHAR(64) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_email_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_campaigns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "MarketingEmailCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "topic" VARCHAR(64) NOT NULL,
    "sender_address_id" UUID,
    "reply_to" VARCHAR(320),
    "subject_override" VARCHAR(998),
    "template_version_id" UUID,
    "audience_id" UUID,
    "segment_id" UUID,
    "frequency_cap_hours" INTEGER NOT NULL DEFAULT 72,
    "legacy_campaign_id" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by_admin_user_id" TEXT NOT NULL,
    "updated_by_admin_user_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by_admin_user_id" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_admin_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_email_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_campaign_snapshots" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" "MarketingCampaignSnapshotKind" NOT NULL,
    "template_version_id" UUID NOT NULL,
    "sender_address" VARCHAR(320) NOT NULL,
    "reply_to" VARCHAR(320),
    "subject" VARCHAR(998) NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "audience_snapshot" JSONB NOT NULL,
    "eligible_count" INTEGER NOT NULL,
    "excluded_count" INTEGER NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_email_campaign_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_email_campaign_approvals" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "decision" "MarketingCampaignApprovalDecision" NOT NULL,
    "reviewer_admin_user_id" TEXT NOT NULL,
    "step_up_id" UUID,
    "snapshot_id" UUID,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_email_campaign_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_organizations_slug" ON "mail_organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_domains_domain" ON "mail_domains"("domain");

-- CreateIndex
CREATE INDEX "IDX_mail_domains_org_status" ON "mail_domains"("organization_id", "status");

-- CreateIndex
CREATE INDEX "IDX_mail_mailboxes_org_type_status" ON "mail_mailboxes"("organization_id", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_mailboxes_personal_owner" ON "mail_mailboxes"("organization_id", "owner_admin_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_addresses_address" ON "mail_addresses"("address");

-- CreateIndex
CREATE INDEX "IDX_mail_addresses_mailbox_status" ON "mail_addresses"("mailbox_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_addresses_domain_local_part" ON "mail_addresses"("domain_id", "local_part");

-- CreateIndex
CREATE INDEX "IDX_mail_memberships_user_active" ON "mail_memberships"("admin_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "IDX_mail_memberships_mailbox_active" ON "mail_memberships"("mailbox_id", "revoked_at");

-- CreateIndex
CREATE INDEX "IDX_mail_sender_grants_user_active" ON "mail_sender_grants"("admin_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "IDX_mail_sender_grants_address_active" ON "mail_sender_grants"("address_id", "revoked_at");

-- CreateIndex
CREATE INDEX "IDX_mail_provision_requests_status_created" ON "mail_provision_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "IDX_mail_provision_requests_requester" ON "mail_provision_requests"("requested_by_admin_user_id", "created_at");

-- CreateIndex
CREATE INDEX "IDX_mail_threads_mailbox_folder_last" ON "mail_threads"("mailbox_id", "folder", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "IDX_mail_threads_mailbox_sent_last" ON "mail_threads"("mailbox_id", "has_outbound", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "IDX_mail_threads_mailbox_root" ON "mail_threads"("mailbox_id", "root_rfc_message_id");

-- CreateIndex
CREATE INDEX "IDX_mail_threads_support_queue" ON "mail_threads"("mailbox_id", "conversation_status", "sla_due_at");

-- CreateIndex
CREATE INDEX "IDX_mail_threads_assignee" ON "mail_threads"("assigned_to_admin_user_id", "conversation_status");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_messages_idempotency_key" ON "mail_messages"("idempotency_key");

-- CreateIndex
CREATE INDEX "IDX_mail_messages_thread_created" ON "mail_messages"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "IDX_mail_messages_mailbox_created" ON "mail_messages"("mailbox_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "IDX_mail_messages_provider_message" ON "mail_messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "IDX_mail_messages_mailbox_rfc" ON "mail_messages"("mailbox_id", "rfc_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_messages_mailbox_rfc_id" ON "mail_messages"("mailbox_id", "rfc_message_id");

-- CreateIndex
CREATE INDEX "IDX_mail_message_recipients_address" ON "mail_message_recipients"("address");

-- CreateIndex
CREATE INDEX "IDX_mail_message_recipients_provider_message" ON "mail_message_recipients"("provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_message_recipients_message_type_address" ON "mail_message_recipients"("message_id", "type", "address");

-- CreateIndex
CREATE INDEX "IDX_mail_user_thread_states_user_starred" ON "mail_user_thread_states"("admin_user_id", "is_starred");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_user_thread_states_thread_user" ON "mail_user_thread_states"("thread_id", "admin_user_id");

-- CreateIndex
CREATE INDEX "IDX_mail_drafts_mailbox_author_status" ON "mail_drafts"("mailbox_id", "author_admin_user_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_labels_mailbox_name" ON "mail_labels"("mailbox_id", "name");

-- CreateIndex
CREATE INDEX "IDX_mail_thread_labels_label" ON "mail_thread_labels"("label_id");

-- CreateIndex
CREATE INDEX "IDX_mail_rules_mailbox_enabled_priority" ON "mail_rules"("mailbox_id", "enabled", "priority");

-- CreateIndex
CREATE INDEX "IDX_mail_attachments_message" ON "mail_attachments"("message_id");

-- CreateIndex
CREATE INDEX "IDX_mail_attachments_draft" ON "mail_attachments"("draft_id");

-- CreateIndex
CREATE INDEX "IDX_mail_internal_notes_thread_created" ON "mail_internal_notes"("thread_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_outbox_jobs_idempotency_key" ON "mail_outbox_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "IDX_mail_outbox_jobs_claim" ON "mail_outbox_jobs"("queue", "status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "IDX_mail_outbox_jobs_lease" ON "mail_outbox_jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "IDX_mail_webhook_events_status_received" ON "mail_webhook_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_webhook_events_provider_event" ON "mail_webhook_events"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "IDX_mail_delivery_events_message_occurred" ON "mail_delivery_events"("message_id", "occurred_at");

-- CreateIndex
CREATE INDEX "IDX_mail_delivery_events_provider_message" ON "mail_delivery_events"("provider_message_id");

-- CreateIndex
CREATE INDEX "IDX_mail_audit_events_mailbox_created" ON "mail_audit_events"("mailbox_id", "created_at");

-- CreateIndex
CREATE INDEX "IDX_mail_audit_events_actor_created" ON "mail_audit_events"("actor_admin_user_id", "created_at");

-- CreateIndex
CREATE INDEX "IDX_mail_audit_events_target" ON "mail_audit_events"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "IDX_mail_retention_policies_org_enabled" ON "mail_retention_policies"("organization_id", "enabled");

-- CreateIndex
CREATE INDEX "IDX_mail_legal_holds_mailbox_active" ON "mail_legal_holds"("mailbox_id", "released_at");

-- CreateIndex
CREATE INDEX "IDX_mail_step_up_user_purpose_expires" ON "mail_step_up_verifications"("admin_user_id", "purpose", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_step_up_user_totp_counter" ON "mail_step_up_verifications"("admin_user_id", "totp_counter");

-- CreateIndex
CREATE INDEX "IDX_mail_break_glass_requester_status" ON "mail_break_glass_requests"("requester_admin_user_id", "status", "access_expires_at");

-- CreateIndex
CREATE INDEX "IDX_mail_break_glass_mailbox_status" ON "mail_break_glass_requests"("mailbox_id", "status");

-- CreateIndex
CREATE INDEX "IDX_marketing_contacts_org_status" ON "marketing_email_contacts"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_contacts_org_email" ON "marketing_email_contacts"("organization_id", "email");

-- CreateIndex
CREATE INDEX "IDX_marketing_consents_org_topic_status" ON "marketing_email_consents"("organization_id", "topic", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_consents_contact_topic" ON "marketing_email_consents"("contact_id", "topic");

-- CreateIndex
CREATE INDEX "IDX_marketing_suppressions_email_active" ON "marketing_email_suppressions"("email", "lifted_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_suppressions_org_active" ON "marketing_email_suppressions"("organization_id", "lifted_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_audiences_org_name" ON "marketing_email_audiences"("organization_id", "name");

-- CreateIndex
CREATE INDEX "IDX_marketing_audience_contacts_contact" ON "marketing_email_audience_contacts"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_segments_audience_name" ON "marketing_email_segments"("audience_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_email_studio_templates_org_name" ON "marketing_email_studio_templates"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_template_versions_template_version" ON "marketing_email_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "IDX_marketing_email_campaigns_org_status" ON "marketing_email_campaigns"("organization_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_campaign_snapshots_campaign_revision_kind" ON "marketing_email_campaign_snapshots"("campaign_id", "revision", "kind");

-- CreateIndex
CREATE INDEX "IDX_marketing_campaign_approvals_campaign_revision" ON "marketing_email_campaign_approvals"("campaign_id", "revision");

-- AddForeignKey
ALTER TABLE "mail_domains" ADD CONSTRAINT "FK_mail_domains_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_mailboxes" ADD CONSTRAINT "FK_mail_mailboxes_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_mailboxes" ADD CONSTRAINT "FK_mail_mailboxes_owner" FOREIGN KEY ("owner_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_addresses" ADD CONSTRAINT "FK_mail_addresses_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_addresses" ADD CONSTRAINT "FK_mail_addresses_domain" FOREIGN KEY ("domain_id") REFERENCES "mail_domains"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_addresses" ADD CONSTRAINT "FK_mail_addresses_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_addresses" ADD CONSTRAINT "FK_mail_addresses_alias_of" FOREIGN KEY ("alias_of_address_id") REFERENCES "mail_addresses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_memberships" ADD CONSTRAINT "FK_mail_memberships_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_memberships" ADD CONSTRAINT "FK_mail_memberships_admin_user" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_sender_grants" ADD CONSTRAINT "FK_mail_sender_grants_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_sender_grants" ADD CONSTRAINT "FK_mail_sender_grants_address" FOREIGN KEY ("address_id") REFERENCES "mail_addresses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_sender_grants" ADD CONSTRAINT "FK_mail_sender_grants_admin_user" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_provision_requests" ADD CONSTRAINT "FK_mail_provision_requests_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_threads" ADD CONSTRAINT "FK_mail_threads_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "FK_mail_messages_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "FK_mail_messages_thread" FOREIGN KEY ("thread_id") REFERENCES "mail_threads"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_message_recipients" ADD CONSTRAINT "FK_mail_message_recipients_message" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_user_thread_states" ADD CONSTRAINT "FK_mail_user_thread_states_thread" FOREIGN KEY ("thread_id") REFERENCES "mail_threads"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_user_thread_states" ADD CONSTRAINT "FK_mail_user_thread_states_admin_user" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_drafts" ADD CONSTRAINT "FK_mail_drafts_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_drafts" ADD CONSTRAINT "FK_mail_drafts_author" FOREIGN KEY ("author_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_drafts" ADD CONSTRAINT "FK_mail_drafts_thread" FOREIGN KEY ("thread_id") REFERENCES "mail_threads"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_labels" ADD CONSTRAINT "FK_mail_labels_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_thread_labels" ADD CONSTRAINT "FK_mail_thread_labels_thread" FOREIGN KEY ("thread_id") REFERENCES "mail_threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_thread_labels" ADD CONSTRAINT "FK_mail_thread_labels_label" FOREIGN KEY ("label_id") REFERENCES "mail_labels"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_rules" ADD CONSTRAINT "FK_mail_rules_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_attachments" ADD CONSTRAINT "FK_mail_attachments_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_attachments" ADD CONSTRAINT "FK_mail_attachments_message" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_attachments" ADD CONSTRAINT "FK_mail_attachments_draft" FOREIGN KEY ("draft_id") REFERENCES "mail_drafts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_internal_notes" ADD CONSTRAINT "FK_mail_internal_notes_thread" FOREIGN KEY ("thread_id") REFERENCES "mail_threads"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_outbox_jobs" ADD CONSTRAINT "FK_mail_outbox_jobs_message" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_outbox_jobs" ADD CONSTRAINT "FK_mail_outbox_jobs_webhook_event" FOREIGN KEY ("webhook_event_id") REFERENCES "mail_webhook_events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_delivery_events" ADD CONSTRAINT "FK_mail_delivery_events_message" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_delivery_events" ADD CONSTRAINT "FK_mail_delivery_events_webhook_event" FOREIGN KEY ("webhook_event_id") REFERENCES "mail_webhook_events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_retention_policies" ADD CONSTRAINT "FK_mail_retention_policies_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_retention_policies" ADD CONSTRAINT "FK_mail_retention_policies_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_legal_holds" ADD CONSTRAINT "FK_mail_legal_holds_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_legal_holds" ADD CONSTRAINT "FK_mail_legal_holds_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_break_glass_requests" ADD CONSTRAINT "FK_mail_break_glass_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_contacts" ADD CONSTRAINT "FK_marketing_contacts_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_consents" ADD CONSTRAINT "FK_marketing_consents_contact" FOREIGN KEY ("contact_id") REFERENCES "marketing_email_contacts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_audiences" ADD CONSTRAINT "FK_marketing_audiences_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_audience_contacts" ADD CONSTRAINT "FK_marketing_audience_contacts_audience" FOREIGN KEY ("audience_id") REFERENCES "marketing_email_audiences"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_audience_contacts" ADD CONSTRAINT "FK_marketing_audience_contacts_contact" FOREIGN KEY ("contact_id") REFERENCES "marketing_email_contacts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_segments" ADD CONSTRAINT "FK_marketing_segments_audience" FOREIGN KEY ("audience_id") REFERENCES "marketing_email_audiences"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_studio_templates" ADD CONSTRAINT "FK_marketing_email_studio_templates_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_template_versions" ADD CONSTRAINT "FK_marketing_template_versions_template" FOREIGN KEY ("template_id") REFERENCES "marketing_email_studio_templates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_campaigns" ADD CONSTRAINT "FK_marketing_email_campaigns_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_campaigns" ADD CONSTRAINT "FK_marketing_email_campaigns_template_version" FOREIGN KEY ("template_version_id") REFERENCES "marketing_email_template_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_campaigns" ADD CONSTRAINT "FK_marketing_email_campaigns_audience" FOREIGN KEY ("audience_id") REFERENCES "marketing_email_audiences"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_campaigns" ADD CONSTRAINT "FK_marketing_email_campaigns_segment" FOREIGN KEY ("segment_id") REFERENCES "marketing_email_segments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_campaign_snapshots" ADD CONSTRAINT "FK_marketing_campaign_snapshots_campaign" FOREIGN KEY ("campaign_id") REFERENCES "marketing_email_campaigns"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_campaign_approvals" ADD CONSTRAINT "FK_marketing_campaign_approvals_campaign" FOREIGN KEY ("campaign_id") REFERENCES "marketing_email_campaigns"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_email_campaign_approvals" ADD CONSTRAINT "FK_marketing_campaign_approvals_snapshot" FOREIGN KEY ("snapshot_id") REFERENCES "marketing_email_campaign_snapshots"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- -----------------------------------------------------------------------------
-- PostgreSQL-only Mail integrity artifacts (Prisma cannot represent these).
-- -----------------------------------------------------------------------------

-- One active membership per mailbox and employee.
CREATE UNIQUE INDEX "UQ_mail_memberships_active_member"
  ON "mail_memberships" ("mailbox_id", "admin_user_id")
  WHERE "revoked_at" IS NULL;

-- One active sender grant per mailbox, address and employee.
CREATE UNIQUE INDEX "UQ_mail_sender_grants_active"
  ON "mail_sender_grants" ("mailbox_id", "address_id", "admin_user_id")
  WHERE "revoked_at" IS NULL;

-- One active suppression per scope (brand or global) and address.
CREATE UNIQUE INDEX "UQ_marketing_email_suppressions_active"
  ON "marketing_email_suppressions" (COALESCE("organization_id"::text, '*'), "email")
  WHERE "lifted_at" IS NULL;

ALTER TABLE "mail_mailboxes"
  ADD CONSTRAINT "CHK_mail_mailboxes_owner_by_type"
    CHECK (("type" = 'PERSONAL' AND "owner_admin_user_id" IS NOT NULL)
        OR ("type" = 'SHARED' AND "owner_admin_user_id" IS NULL)),
  ADD CONSTRAINT "CHK_mail_mailboxes_send_quota"
    CHECK ("daily_send_quota" BETWEEN 0 AND 100000);

ALTER TABLE "mail_domains"
  ADD CONSTRAINT "CHK_mail_domains_normalized"
    CHECK ("domain" = lower(btrim("domain")) AND "domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');

ALTER TABLE "mail_addresses"
  ADD CONSTRAINT "CHK_mail_addresses_normalized"
    CHECK ("address" = lower(btrim("address")) AND "local_part" = lower(btrim("local_part"))),
  ADD CONSTRAINT "CHK_mail_addresses_alias_target"
    CHECK (("kind" = 'ALIAS' AND "alias_of_address_id" IS NOT NULL AND "alias_of_address_id" <> "id")
        OR ("kind" <> 'ALIAS' AND "alias_of_address_id" IS NULL));

ALTER TABLE "mail_drafts"
  ADD CONSTRAINT "CHK_mail_drafts_revision" CHECK ("revision" >= 1);

ALTER TABLE "mail_outbox_jobs"
  ADD CONSTRAINT "CHK_mail_outbox_jobs_attempts"
    CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 50);

ALTER TABLE "mail_attachments"
  ADD CONSTRAINT "CHK_mail_attachments_owner"
    CHECK ("message_id" IS NOT NULL OR "draft_id" IS NOT NULL OR "quarantined" = true),
  ADD CONSTRAINT "CHK_mail_attachments_size" CHECK ("size_bytes" >= 0);

ALTER TABLE "marketing_email_contacts"
  ADD CONSTRAINT "CHK_marketing_email_contacts_normalized"
    CHECK ("email" = lower(btrim("email")));

ALTER TABLE "marketing_email_suppressions"
  ADD CONSTRAINT "CHK_marketing_email_suppressions_normalized"
    CHECK ("email" = lower(btrim("email")));

ALTER TABLE "marketing_email_campaigns"
  ADD CONSTRAINT "CHK_marketing_email_campaigns_frequency_cap"
    CHECK ("frequency_cap_hours" BETWEEN 0 AND 8760);

ALTER TABLE "mail_break_glass_requests"
  ADD CONSTRAINT "CHK_mail_break_glass_distinct_approver"
    CHECK ("approver_admin_user_id" IS NULL OR "approver_admin_user_id" <> "requester_admin_user_id"),
  ADD CONSTRAINT "CHK_mail_break_glass_window"
    CHECK ("access_expires_at" IS NULL OR "decided_at" IS NULL OR "access_expires_at" <= "decided_at" + INTERVAL '4 hours');

ALTER TABLE "marketing_email_campaign_approvals"
  ADD CONSTRAINT "CHK_marketing_campaign_approvals_step_up"
    CHECK ("decision" <> 'APPROVED' OR "step_up_id" IS NOT NULL);

-- Mailbox-scoped METADATA full-text search (subject, sender, non-BCC
-- recipients). Message bodies are never indexed or stored in plaintext;
-- membership is enforced in the query.
CREATE INDEX "IDX_mail_messages_metadata_search_fts"
  ON "mail_messages" USING GIN (to_tsvector('simple', "metadata_search_text"));

-- Append-only evidence: Mail audit events, campaign snapshots and template
-- versions can never be updated or deleted by the application.
CREATE OR REPLACE FUNCTION prevent_mail_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'mail evidence row in % is immutable', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER "TRG_mail_audit_events_immutable"
  BEFORE UPDATE OR DELETE ON "mail_audit_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_mail_evidence_mutation();

CREATE TRIGGER "TRG_marketing_campaign_snapshots_immutable"
  BEFORE UPDATE OR DELETE ON "marketing_email_campaign_snapshots"
  FOR EACH ROW EXECUTE FUNCTION prevent_mail_evidence_mutation();

CREATE TRIGGER "TRG_marketing_template_versions_immutable"
  BEFORE UPDATE OR DELETE ON "marketing_email_template_versions"
  FOR EACH ROW EXECUTE FUNCTION prevent_mail_evidence_mutation();

-- Legal holds block hard deletion of held mail content.
CREATE OR REPLACE FUNCTION prevent_mail_delete_under_legal_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "mail_legal_holds" hold
    WHERE hold."released_at" IS NULL
      AND (
        hold."mailbox_id" = OLD."mailbox_id"
        OR (
          hold."mailbox_id" IS NULL
          AND hold."organization_id" = (
            SELECT mailbox."organization_id" FROM "mail_mailboxes" mailbox
            WHERE mailbox."id" = OLD."mailbox_id"
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'mail content in mailbox % is under legal hold', OLD."mailbox_id"
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "TRG_mail_messages_legal_hold"
  BEFORE DELETE ON "mail_messages"
  FOR EACH ROW EXECUTE FUNCTION prevent_mail_delete_under_legal_hold();

CREATE TRIGGER "TRG_mail_attachments_legal_hold"
  BEFORE DELETE ON "mail_attachments"
  FOR EACH ROW EXECUTE FUNCTION prevent_mail_delete_under_legal_hold();
