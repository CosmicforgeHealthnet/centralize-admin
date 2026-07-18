-- Section 5: Social Media Operations data model.
-- Additive local migration only; does not alter existing Marketing Intelligence tables.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$ BEGIN CREATE TYPE "SocialProvider" AS ENUM ('META', 'TIKTOK', 'X', 'LINKEDIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialIdentityType" AS ENUM ('FACEBOOK_PAGE', 'INSTAGRAM_PROFESSIONAL', 'TIKTOK_ACCOUNT', 'X_USER', 'LINKEDIN_ORGANIZATION', 'LINKEDIN_MEMBER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialConnectionStatus" AS ENUM ('PENDING_AUTHORIZATION', 'PENDING_PLATFORM_APPROVAL', 'ACTIVE', 'DISABLED', 'ERROR', 'REAUTHORIZATION_REQUIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialPostStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHING', 'PARTIALLY_PUBLISHED', 'PUBLISHED', 'FAILED', 'CANCELLED', 'ARCHIVED', 'LEGACY_PUBLISHED_UNVERIFIED', 'LEGACY_SCHEDULED_UNVERIFIED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialTargetStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialPublicationStatus" AS ENUM ('PENDING', 'VALIDATING', 'UPLOADING', 'PROCESSING', 'PUBLISHING', 'AWAITING_USER_ACTION', 'PUBLISHED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'CANCELLED', 'DELETED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialJobStatus" AS ENUM ('PENDING', 'CLAIMED', 'RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialActionJobType" AS ENUM ('POLL_PUBLICATION', 'DELETE_PROVIDER_POST', 'SEND_MESSAGE', 'REPLY_COMMENT', 'HIDE_COMMENT', 'DELETE_COMMENT', 'SYNC_PROVIDER_CONTENT', 'SYNC_COMMENTS', 'SYNC_MESSAGES', 'SYNC_METRICS'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialActionStatus" AS ENUM ('PENDING', 'CLAIMED', 'RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialConversationStatus" AS ENUM ('OPEN', 'PENDING', 'SNOOZED', 'RESOLVED', 'SPAM', 'ARCHIVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialMessageType" AS ENUM ('TEXT', 'ATTACHMENT', 'TEMPLATE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialMessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialCommentDirection" AS ENUM ('INBOUND', 'OUTBOUND'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialModerationStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'DELETED', 'FLAGGED', 'ESCALATED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialEngagementType" AS ENUM ('REACTION', 'MENTION', 'FOLLOW', 'OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialSensitiveDataState" AS ENUM ('UNCLASSIFIED', 'CLEAR', 'FLAGGED', 'CONFIRMED', 'REDACTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialEscalationClassification" AS ENUM ('MEDICAL_EMERGENCY', 'SELF_HARM_RISK', 'CLINICAL_ADVICE_REQUEST', 'PRESCRIPTION_REQUEST', 'PROTECTED_HEALTH_INFORMATION', 'PRIVACY_INCIDENT', 'PATIENT_COMPLAINT', 'LEGAL_THREAT', 'MEDICAL_MISINFORMATION', 'GENERAL_INQUIRY'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialEscalationStatus" AS ENUM ('DETECTED', 'CONFIRMED', 'DISMISSED', 'RESOLVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED_DUPLICATE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialWebhookSubscriptionStatus" AS ENUM ('ACTIVE', 'DEGRADED', 'UNSUBSCRIBED', 'ERROR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialAssetStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'DELETED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialPostingMode" AS ENUM ('DIRECT_POST', 'UPLOAD_TO_DRAFT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialProviderContentSource" AS ENUM ('ADMIN_PUBLISHED', 'PROVIDER_IMPORTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialProviderContentType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL', 'REEL', 'STORY', 'LINK', 'DOCUMENT', 'OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "social_account_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" "SocialProvider" NOT NULL,
  "provider_connection_id" TEXT NOT NULL,
  "encrypted_credentials" BYTEA NOT NULL,
  "credential_version" INTEGER NOT NULL DEFAULT 1,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "SocialConnectionStatus" NOT NULL DEFAULT 'PENDING_AUTHORIZATION',
  "access_token_expires_at" TIMESTAMP(3),
  "refresh_token_expires_at" TIMESTAMP(3),
  "requires_reauthorization" BOOLEAN NOT NULL DEFAULT false,
  "last_tested_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_account_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_account_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_publishing_identities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "connection_id" UUID NOT NULL,
  "provider_identity_id" TEXT NOT NULL,
  "type" "SocialIdentityType" NOT NULL,
  "name" TEXT NOT NULL,
  "username" TEXT,
  "avatar_url" TEXT,
  "capabilities_json" JSONB NOT NULL,
  "role" TEXT,
  "disabled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_publishing_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_publishing_identities_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "social_account_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_oauth_states" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "state_hash" TEXT NOT NULL,
  "provider" "SocialProvider" NOT NULL,
  "admin_user_id" TEXT NOT NULL,
  "connection_context_json" JSONB,
  "encrypted_verifier" BYTEA,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_oauth_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_oauth_states_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_posts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "title" TEXT,
  "status" "SocialPostStatus" NOT NULL DEFAULT 'DRAFT',
  "campaign_id" TEXT,
  "created_by_id" TEXT NOT NULL,
  "current_version" INTEGER NOT NULL DEFAULT 1,
  "legacy_source_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_posts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "social_posts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_post_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "post_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "title" TEXT,
  "base_text" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "change_summary" TEXT,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_post_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_post_revisions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "social_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_post_revisions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_post_targets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "post_id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "status" "SocialTargetStatus" NOT NULL DEFAULT 'DRAFT',
  "text" TEXT NOT NULL,
  "options_json" JSONB,
  "content_version" INTEGER NOT NULL DEFAULT 1,
  "capability_snapshot_json" JSONB,
  "validation_status" TEXT,
  "validation_errors_json" JSONB,
  "last_validated_at" TIMESTAMP(3),
  "scheduled_for_utc" TIMESTAMP(3),
  "timezone" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_post_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_post_targets_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "social_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_post_targets_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_post_approvals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "post_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "target_id" UUID,
  "submitted_by_id" TEXT NOT NULL,
  "decided_by_id" TEXT,
  "decision" "SocialApprovalDecision" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMP(3),
  CONSTRAINT "social_post_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_post_approvals_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "social_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_post_approvals_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "social_post_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_post_approvals_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "social_post_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_post_approvals_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_post_approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_publications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "target_id" UUID NOT NULL,
  "post_version" INTEGER NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "approved_by_id" TEXT,
  "provider_post_id" TEXT,
  "url" TEXT,
  "status" "SocialPublicationStatus" NOT NULL DEFAULT 'PENDING',
  "posting_mode" "SocialPostingMode",
  "idempotency_key" TEXT NOT NULL,
  "published_at" TIMESTAMP(3),
  "last_error" TEXT,
  "last_error_category" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_publications_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "social_post_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_publications_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_publications_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_publication_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "publication_id" UUID NOT NULL,
  "attempt_no" INTEGER NOT NULL,
  "category" TEXT,
  "response_meta_json" JSONB,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "social_publication_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_publication_attempts_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "social_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_publishing_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "publication_id" UUID NOT NULL,
  "status" "SocialJobStatus" NOT NULL DEFAULT 'PENDING',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "scheduled_for_utc" TIMESTAMP(3) NOT NULL,
  "next_attempt_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 6,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "heartbeat_at" TIMESTAMP(3),
  "last_error_category" TEXT,
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_publishing_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_publishing_jobs_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "social_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_media_assets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_id" TEXT NOT NULL,
  "storage_provider" TEXT NOT NULL DEFAULT 'CLOUDINARY',
  "storage_key" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secure_url" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "duration_ms" INTEGER,
  "aspect_ratio" TEXT,
  "checksum_sha256" TEXT NOT NULL,
  "status" "SocialAssetStatus" NOT NULL DEFAULT 'UPLOADING',
  "processing_metadata_json" JSONB,
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_media_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_post_media" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "target_id" UUID NOT NULL,
  "asset_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "alt_text" TEXT,
  "provider_options_json" JSONB,
  CONSTRAINT "social_post_media_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_post_media_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "social_post_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_post_media_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "social_media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_contacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "identity_id" UUID NOT NULL,
  "provider_user_id" TEXT NOT NULL,
  "display_name" TEXT,
  "username" TEXT,
  "avatar_url" TEXT,
  "linked_subject_type" TEXT,
  "linked_subject_id" TEXT,
  "linked_subject_source" TEXT,
  "linked_at" TIMESTAMP(3),
  "linked_by_id" TEXT,
  "consent_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_contacts_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_contacts_linked_by_id_fkey" FOREIGN KEY ("linked_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_conversations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "identity_id" UUID NOT NULL,
  "provider_conversation_id" TEXT NOT NULL,
  "contact_id" UUID NOT NULL,
  "state" "SocialConversationStatus" NOT NULL DEFAULT 'OPEN',
  "priority" TEXT,
  "assignee_id" TEXT,
  "assigned_at" TIMESTAMP(3),
  "assigned_by_id" TEXT,
  "first_response_due_at" TIMESTAMP(3),
  "resolution_due_at" TIMESTAMP(3),
  "first_responded_at" TIMESTAMP(3),
  "sla_deadline_at" TIMESTAMP(3),
  "snoozed_until" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "native_url" TEXT,
  "unread_count" INTEGER NOT NULL DEFAULT 0,
  "last_inbound_at" TIMESTAMP(3),
  "last_outbound_at" TIMESTAMP(3),
  "last_message_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_conversations_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "social_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_conversations_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "social_conversations_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL,
  "provider_message_id" TEXT,
  "client_idempotency_key" TEXT,
  "direction" "SocialMessageDirection" NOT NULL,
  "type" "SocialMessageType" NOT NULL,
  "content" TEXT,
  "content_hash" TEXT,
  "attachments_json" JSONB,
  "status" "SocialMessageStatus" NOT NULL DEFAULT 'QUEUED',
  "sensitive_data_state" "SocialSensitiveDataState" NOT NULL DEFAULT 'UNCLASSIFIED',
  "retention_expires_at" TIMESTAMP(3),
  "redacted_at" TIMESTAMP(3),
  "sent_by_admin_id" TEXT,
  "error_message" TEXT,
  "provider_created_at" TIMESTAMP(3),
  "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "read_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  CONSTRAINT "social_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "social_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_messages_sent_by_admin_id_fkey" FOREIGN KEY ("sent_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_tags" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "color" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_tags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "social_conversation_tags" (
  "conversation_id" UUID NOT NULL,
  "tag_id" UUID NOT NULL,
  "tagged_by_id" TEXT NOT NULL,
  "tagged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_conversation_tags_pkey" PRIMARY KEY ("conversation_id","tag_id"),
  CONSTRAINT "social_conversation_tags_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "social_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_conversation_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "social_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_conversation_tags_tagged_by_id_fkey" FOREIGN KEY ("tagged_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_provider_content" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "identity_id" UUID NOT NULL,
  "provider_content_id" TEXT NOT NULL,
  "source" "SocialProviderContentSource" NOT NULL,
  "content_type" "SocialProviderContentType" NOT NULL,
  "text" TEXT,
  "provider_url" TEXT,
  "provider_created_at" TIMESTAMP(3),
  "provider_updated_at" TIMESTAMP(3),
  "publication_id" UUID,
  "metadata_json" JSONB,
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_provider_content_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_provider_content_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_provider_content_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "social_publications"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_comments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "identity_id" UUID NOT NULL,
  "provider_content_id" UUID NOT NULL,
  "provider_comment_id" TEXT,
  "client_idempotency_key" TEXT,
  "provider_parent_comment_id" TEXT,
  "parent_id" UUID,
  "direction" "SocialCommentDirection" NOT NULL DEFAULT 'INBOUND',
  "author_contact_id" UUID,
  "author_json" JSONB,
  "text" TEXT,
  "content_hash" TEXT,
  "sensitive_data_state" "SocialSensitiveDataState" NOT NULL DEFAULT 'UNCLASSIFIED',
  "retention_expires_at" TIMESTAMP(3),
  "redacted_at" TIMESTAMP(3),
  "moderation_state" "SocialModerationStatus" NOT NULL DEFAULT 'VISIBLE',
  "assignee_id" TEXT,
  "priority" TEXT,
  "sent_by_admin_id" TEXT,
  "provider_status" TEXT,
  "last_error_category" TEXT,
  "last_error" TEXT,
  "native_url" TEXT,
  "provider_created_at" TIMESTAMP(3),
  "queued_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "social_comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_comments_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_comments_provider_content_id_fkey" FOREIGN KEY ("provider_content_id") REFERENCES "social_provider_content"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "social_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "social_comments_author_contact_id_fkey" FOREIGN KEY ("author_contact_id") REFERENCES "social_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "social_comments_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "social_comments_sent_by_admin_id_fkey" FOREIGN KEY ("sent_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_engagement_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "identity_id" UUID NOT NULL,
  "type" "SocialEngagementType" NOT NULL,
  "provider_event_id" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "payload_json" JSONB NOT NULL,
  CONSTRAINT "social_engagement_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_engagement_events_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_escalations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "entity_type" TEXT NOT NULL,
  "entity_id" UUID NOT NULL,
  "classification" "SocialEscalationClassification" NOT NULL,
  "status" "SocialEscalationStatus" NOT NULL DEFAULT 'DETECTED',
  "restricted_visibility" BOOLEAN NOT NULL DEFAULT true,
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_by_id" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "task_id" TEXT,
  "resolved_at" TIMESTAMP(3),
  "resolution_notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_escalations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_escalations_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_escalations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_webhook_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "connection_id" UUID NOT NULL,
  "identity_id" UUID,
  "event_type" TEXT NOT NULL,
  "provider_subscription_id" TEXT,
  "status" "SocialWebhookSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
  "last_verified_at" TIMESTAMP(3),
  "last_event_at" TIMESTAMP(3),
  "last_error" TEXT,
  CONSTRAINT "social_webhook_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_webhook_subscriptions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "social_account_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_webhook_subscriptions_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_webhook_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" "SocialProvider" NOT NULL,
  "event_id" TEXT,
  "payload_hash" TEXT NOT NULL,
  "identity_provider_id" TEXT,
  "provider_event_type" TEXT,
  "status" "SocialWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
  "signature_valid" BOOLEAN NOT NULL,
  "encrypted_raw_payload" BYTEA NOT NULL,
  "payload_metadata_json" JSONB,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processing_started_at" TIMESTAMP(3),
  "processed_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "last_error" TEXT,
  "retention_expires_at" TIMESTAMP(3),
  "redacted_at" TIMESTAMP(3),
  CONSTRAINT "social_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "social_identity_metric_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "identity_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "impressions" INTEGER,
  "reach" INTEGER,
  "followers" INTEGER,
  "raw_json" JSONB NOT NULL,
  CONSTRAINT "social_identity_metric_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_identity_metric_snapshots_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_provider_content_metric_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider_content_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "impressions" INTEGER,
  "reach" INTEGER,
  "views" INTEGER,
  "clicks" INTEGER,
  "reactions" INTEGER,
  "comments" INTEGER,
  "shares" INTEGER,
  "video_views" INTEGER,
  "watch_time_ms" BIGINT,
  "raw_json" JSONB NOT NULL,
  CONSTRAINT "social_provider_content_metric_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_provider_content_metric_snapshots_provider_content_id_fkey" FOREIGN KEY ("provider_content_id") REFERENCES "social_provider_content"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_identity_sync_state" (
  "identity_id" UUID NOT NULL,
  "last_content_sync" TIMESTAMP(3),
  "last_comment_sync" TIMESTAMP(3),
  "last_message_sync" TIMESTAMP(3),
  "last_metric_sync" TIMESTAMP(3),
  "content_cursor" TEXT,
  "comment_cursor" TEXT,
  "message_cursor" TEXT,
  "metric_cursor" TEXT,
  "last_error" TEXT,
  CONSTRAINT "social_identity_sync_state_pkey" PRIMARY KEY ("identity_id"),
  CONSTRAINT "social_identity_sync_state_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_action_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "job_type" "SocialActionJobType" NOT NULL,
  "status" "SocialActionStatus" NOT NULL DEFAULT 'PENDING',
  "identity_id" UUID NOT NULL,
  "publication_id" UUID,
  "provider_content_id" UUID,
  "message_id" UUID,
  "comment_id" UUID,
  "idempotency_key" TEXT NOT NULL,
  "payload_json" JSONB,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "scheduled_for_utc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "next_attempt_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 6,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "heartbeat_at" TIMESTAMP(3),
  "last_error_category" TEXT,
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_action_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_action_jobs_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "social_publishing_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "social_action_jobs_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "social_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_action_jobs_provider_content_id_fkey" FOREIGN KEY ("provider_content_id") REFERENCES "social_provider_content"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_action_jobs_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "social_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_action_jobs_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "social_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_action_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "job_id" UUID NOT NULL,
  "attempt_no" INTEGER NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "result_status" TEXT,
  "error_category" TEXT,
  "sanitized_error" TEXT,
  "provider_request_id" TEXT,
  "response_meta_json" JSONB,
  "retry_after" TIMESTAMP(3),
  CONSTRAINT "social_action_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_action_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "social_action_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_internal_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "entity_type" TEXT NOT NULL,
  "entity_id" UUID NOT NULL,
  "text" TEXT,
  "content_hash" TEXT,
  "sensitive_data_state" "SocialSensitiveDataState" NOT NULL DEFAULT 'UNCLASSIFIED',
  "restricted_visibility" BOOLEAN NOT NULL DEFAULT false,
  "retention_expires_at" TIMESTAMP(3),
  "redacted_at" TIMESTAMP(3),
  "author_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_internal_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_internal_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_saved_replies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "variables_json" JSONB,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_saved_replies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_saved_replies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "social_operations_settings" (
  "key" TEXT NOT NULL,
  "value_json" JSONB NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_operations_settings_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "social_operations_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "social_account_connections_status_idx" ON "social_account_connections"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "social_account_connections_provider_provider_connection_id_key" ON "social_account_connections"("provider", "provider_connection_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_publishing_identities_connection_id_provider_identit_key" ON "social_publishing_identities"("connection_id", "provider_identity_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_oauth_states_state_hash_key" ON "social_oauth_states"("state_hash");
CREATE INDEX IF NOT EXISTS "social_oauth_states_expires_at_idx" ON "social_oauth_states"("expires_at");
CREATE INDEX IF NOT EXISTS "social_posts_status_idx" ON "social_posts"("status");
CREATE INDEX IF NOT EXISTS "social_posts_campaign_id_idx" ON "social_posts"("campaign_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_post_revisions_post_id_version_key" ON "social_post_revisions"("post_id", "version");
CREATE INDEX IF NOT EXISTS "social_post_targets_scheduled_for_utc_idx" ON "social_post_targets"("scheduled_for_utc");
CREATE INDEX IF NOT EXISTS "social_post_targets_status_idx" ON "social_post_targets"("status");
CREATE INDEX IF NOT EXISTS "social_post_approvals_post_id_idx" ON "social_post_approvals"("post_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_publications_idempotency_key_key" ON "social_publications"("idempotency_key");
CREATE INDEX IF NOT EXISTS "social_publications_status_idx" ON "social_publications"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "social_publications_target_id_post_version_key" ON "social_publications"("target_id", "post_version");
CREATE UNIQUE INDEX IF NOT EXISTS "social_publication_attempts_publication_id_attempt_no_key" ON "social_publication_attempts"("publication_id", "attempt_no");
CREATE UNIQUE INDEX IF NOT EXISTS "social_publishing_jobs_publication_id_key" ON "social_publishing_jobs"("publication_id");
CREATE INDEX IF NOT EXISTS "social_publishing_jobs_status_scheduled_for_utc_idx" ON "social_publishing_jobs"("status", "scheduled_for_utc");
CREATE INDEX IF NOT EXISTS "social_publishing_jobs_lease_expires_at_idx" ON "social_publishing_jobs"("lease_expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "social_media_assets_owner_id_checksum_sha256_key" ON "social_media_assets"("owner_id", "checksum_sha256");
CREATE UNIQUE INDEX IF NOT EXISTS "social_post_media_target_id_position_key" ON "social_post_media"("target_id", "position");
CREATE INDEX IF NOT EXISTS "social_contacts_linked_subject_type_linked_subject_id_idx" ON "social_contacts"("linked_subject_type", "linked_subject_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_contacts_identity_id_provider_user_id_key" ON "social_contacts"("identity_id", "provider_user_id");
CREATE INDEX IF NOT EXISTS "social_conversations_state_last_message_at_idx" ON "social_conversations"("state", "last_message_at");
CREATE INDEX IF NOT EXISTS "social_conversations_assignee_id_sla_deadline_at_idx" ON "social_conversations"("assignee_id", "sla_deadline_at");
CREATE UNIQUE INDEX IF NOT EXISTS "social_conversations_identity_id_provider_conversation_id_key" ON "social_conversations"("identity_id", "provider_conversation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_messages_client_idempotency_key_key" ON "social_messages"("client_idempotency_key");
CREATE INDEX IF NOT EXISTS "social_messages_sensitive_data_state_retention_expires_at_idx" ON "social_messages"("sensitive_data_state", "retention_expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "social_messages_conversation_id_provider_message_id_key" ON "social_messages"("conversation_id", "provider_message_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_tags_name_key" ON "social_tags"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "social_provider_content_publication_id_key" ON "social_provider_content"("publication_id");
CREATE INDEX IF NOT EXISTS "social_provider_content_identity_id_provider_created_at_idx" ON "social_provider_content"("identity_id", "provider_created_at");
CREATE INDEX IF NOT EXISTS "social_provider_content_source_idx" ON "social_provider_content"("source");
CREATE UNIQUE INDEX IF NOT EXISTS "social_provider_content_identity_id_provider_content_id_key" ON "social_provider_content"("identity_id", "provider_content_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_comments_client_idempotency_key_key" ON "social_comments"("client_idempotency_key");
CREATE INDEX IF NOT EXISTS "social_comments_provider_content_id_idx" ON "social_comments"("provider_content_id");
CREATE INDEX IF NOT EXISTS "social_comments_parent_id_idx" ON "social_comments"("parent_id");
CREATE INDEX IF NOT EXISTS "social_comments_moderation_state_idx" ON "social_comments"("moderation_state");
CREATE INDEX IF NOT EXISTS "social_comments_sensitive_data_state_retention_expires_at_idx" ON "social_comments"("sensitive_data_state", "retention_expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "social_comments_identity_id_provider_comment_id_key" ON "social_comments"("identity_id", "provider_comment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_engagement_events_identity_id_provider_event_id_key" ON "social_engagement_events"("identity_id", "provider_event_id");
CREATE INDEX IF NOT EXISTS "social_escalations_entity_type_entity_id_idx" ON "social_escalations"("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "social_escalations_classification_status_idx" ON "social_escalations"("classification", "status");
CREATE INDEX IF NOT EXISTS "social_escalations_status_restricted_visibility_idx" ON "social_escalations"("status", "restricted_visibility");
CREATE INDEX IF NOT EXISTS "social_webhook_subscriptions_connection_id_event_type_idx" ON "social_webhook_subscriptions"("connection_id", "event_type");
CREATE INDEX IF NOT EXISTS "social_webhook_subscriptions_connection_id_identity_id_even_idx" ON "social_webhook_subscriptions"("connection_id", "identity_id", "event_type");
CREATE UNIQUE INDEX IF NOT EXISTS social_webhook_subscription_connection_event_unique ON "social_webhook_subscriptions" ("connection_id", "event_type") WHERE "identity_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS social_webhook_subscription_identity_event_unique ON "social_webhook_subscriptions" ("connection_id", "identity_id", "event_type") WHERE "identity_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "social_webhook_events_status_next_attempt_at_idx" ON "social_webhook_events"("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "social_webhook_events_retention_expires_at_idx" ON "social_webhook_events"("retention_expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "social_webhook_events_provider_event_id_key" ON "social_webhook_events"("provider", "event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "social_webhook_events_provider_payload_hash_key" ON "social_webhook_events"("provider", "payload_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "social_identity_metric_snapshots_identity_id_date_key" ON "social_identity_metric_snapshots"("identity_id", "date");
CREATE UNIQUE INDEX IF NOT EXISTS "social_provider_content_metric_snapshots_provider_content_i_key" ON "social_provider_content_metric_snapshots"("provider_content_id", "date");
CREATE UNIQUE INDEX IF NOT EXISTS "social_action_jobs_idempotency_key_key" ON "social_action_jobs"("idempotency_key");
CREATE INDEX IF NOT EXISTS "social_action_jobs_status_scheduled_for_utc_idx" ON "social_action_jobs"("status", "scheduled_for_utc");
CREATE INDEX IF NOT EXISTS "social_action_jobs_status_next_attempt_at_idx" ON "social_action_jobs"("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "social_action_jobs_lease_expires_at_idx" ON "social_action_jobs"("lease_expires_at");
CREATE INDEX IF NOT EXISTS "social_action_jobs_identity_id_job_type_idx" ON "social_action_jobs"("identity_id", "job_type");
CREATE UNIQUE INDEX IF NOT EXISTS "social_action_attempts_job_id_attempt_no_key" ON "social_action_attempts"("job_id", "attempt_no");
CREATE INDEX IF NOT EXISTS "social_internal_notes_entity_type_entity_id_idx" ON "social_internal_notes"("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "social_internal_notes_sensitive_data_state_retention_expire_idx" ON "social_internal_notes"("sensitive_data_state", "retention_expires_at");
