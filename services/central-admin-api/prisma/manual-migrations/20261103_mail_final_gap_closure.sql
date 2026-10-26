-- CosmicForge Mail final gap closure (acceptance report section F, gaps 1-8).
-- Additive only; NEW TABLES ONLY. No existing table gains or loses a column,
-- so code deployed before this migration never selects anything missing.
-- Until it is applied every feature below answers 503 MAIL_FEATURE_NOT_READY
-- (or keeps its pre-37 behaviour) and core Mail keeps working.
--   marketing_template_policies / _version_policies  gap 1 template classification
--   marketing_contact_provider_states                gap 2 provider subscription state
--   marketing_provider_resubscriptions               gap 2 approved re-subscriptions
--   mail_provider_pricing                            gap 3 approved pricing (estimates only)
--   mail_provider_quota_observations                 gap 3 observed provider quota
--   marketing_dispatch_costs                         gap 3 per-dispatch cost estimate
--   marketing_automation_replays                     gap 4 audited replay / recovery
--   mail_storage_deletions                           gap 5 durable object deletions
--   mail_quarantine_decisions                        gap 6 IT quarantine decisions (append-only)
--   mail_message_provider_ids                        gap 8 provider-assigned Message-ID
-- Rollback: docs/sql/cosmicforge-mail-final-gap-closure-rollback.sql.

-- CreateTable
CREATE TABLE "marketing_template_policies" (
    "template_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "classification" VARCHAR(32) NOT NULL,
    "changed_by" TEXT NOT NULL,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_template_policies_pkey" PRIMARY KEY ("template_id")
);

-- CreateTable
CREATE TABLE "marketing_template_version_policies" (
    "version_id" UUID NOT NULL,
    "classification" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_template_version_policies_pkey" PRIMARY KEY ("version_id")
);

-- CreateTable
CREATE TABLE "marketing_contact_provider_states" (
    "contact_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(64),
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_contact_provider_states_pkey" PRIMARY KEY ("contact_id")
);

-- CreateTable
CREATE TABLE "marketing_provider_resubscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "topic" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "consent_evidence" JSONB NOT NULL,
    "requested_by" TEXT,
    "approved_by" TEXT,
    "provider_result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(255),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_provider_resubscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_provider_pricing" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "organization_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "unit_cost_micros" BIGINT NOT NULL,
    "included_monthly" INTEGER,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "source" VARCHAR(32) NOT NULL,
    "reference" VARCHAR(200) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_provider_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_provider_quota_observations" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "daily_used" INTEGER,
    "monthly_used" INTEGER,
    "daily_limit" INTEGER,
    "monthly_limit" INTEGER,
    "source" VARCHAR(32) NOT NULL,
    "exhausted_kind" VARCHAR(16),
    "exhausted_until" TIMESTAMPTZ(6),

    CONSTRAINT "mail_provider_quota_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_dispatch_costs" (
    "dispatch_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pricing_id" UUID,
    "basis" VARCHAR(32) NOT NULL,
    "basis_count" INTEGER NOT NULL,
    "estimated_cost_micros" BIGINT,
    "currency" CHAR(3),
    "status" VARCHAR(16) NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "marketing_dispatch_costs_pkey" PRIMARY KEY ("dispatch_id")
);

-- CreateTable
CREATE TABLE "marketing_automation_replays" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "automation_id" UUID NOT NULL,
    "enrollment_id" UUID,
    "step_run_id" UUID,
    "outbox_job_id" UUID,
    "scope" VARCHAR(32) NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "requested_by" TEXT NOT NULL,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMPTZ(6),

    CONSTRAINT "marketing_automation_replays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_storage_deletions" (
    "id" UUID NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "source_type" VARCHAR(32),
    "source_id" VARCHAR(64),
    "organization_id" UUID,
    "mailbox_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(6),
    "last_error" VARCHAR(255),
    "requested_by" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_storage_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_quarantine_decisions" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "target_type" VARCHAR(16) NOT NULL,
    "message_id" UUID,
    "attachment_id" UUID,
    "decision" VARCHAR(24) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "scan_evidence" JSONB,
    "decided_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_quarantine_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_message_provider_ids" (
    "message_id" UUID NOT NULL,
    "provider_rfc_message_id" VARCHAR(998) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_message_provider_ids_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE INDEX "IDX_marketing_template_policies_org_class" ON "marketing_template_policies"("organization_id", "classification");

-- CreateIndex
CREATE INDEX "IDX_marketing_contact_provider_states_org_state" ON "marketing_contact_provider_states"("organization_id", "state");

-- CreateIndex
CREATE INDEX "IDX_marketing_provider_resubscriptions_org_status" ON "marketing_provider_resubscriptions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "IDX_marketing_provider_resubscriptions_contact" ON "marketing_provider_resubscriptions"("contact_id");

-- CreateIndex
CREATE INDEX "IDX_mail_provider_pricing_provider_from" ON "mail_provider_pricing"("provider", "effective_from");

-- CreateIndex
CREATE INDEX "IDX_mail_provider_quota_observations_scope_time" ON "mail_provider_quota_observations"("provider", "scope", "observed_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_dispatch_costs_org_time" ON "marketing_dispatch_costs"("organization_id", "computed_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_automation_replays_automation_time" ON "marketing_automation_replays"("automation_id", "created_at");

-- CreateIndex
CREATE INDEX "IDX_mail_storage_deletions_status_next" ON "mail_storage_deletions"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "IDX_mail_storage_deletions_object_key" ON "mail_storage_deletions"("object_key");

-- CreateIndex
CREATE INDEX "IDX_mail_quarantine_decisions_mailbox_time" ON "mail_quarantine_decisions"("mailbox_id", "created_at");

-- CreateIndex
CREATE INDEX "IDX_mail_quarantine_decisions_message" ON "mail_quarantine_decisions"("message_id");

-- CreateIndex
CREATE INDEX "IDX_mail_quarantine_decisions_attachment" ON "mail_quarantine_decisions"("attachment_id");

-- CreateIndex
CREATE INDEX "IDX_mail_message_provider_ids_rfc" ON "mail_message_provider_ids"("provider_rfc_message_id");

-- AddForeignKey
ALTER TABLE "marketing_template_policies" ADD CONSTRAINT "FK_marketing_template_policies_template" FOREIGN KEY ("template_id") REFERENCES "marketing_email_studio_templates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_template_version_policies" ADD CONSTRAINT "FK_marketing_template_version_policies_version" FOREIGN KEY ("version_id") REFERENCES "marketing_email_template_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_contact_provider_states" ADD CONSTRAINT "FK_marketing_contact_provider_states_contact" FOREIGN KEY ("contact_id") REFERENCES "marketing_email_contacts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_provider_resubscriptions" ADD CONSTRAINT "FK_marketing_provider_resubscriptions_contact" FOREIGN KEY ("contact_id") REFERENCES "marketing_email_contacts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_dispatch_costs" ADD CONSTRAINT "FK_marketing_dispatch_costs_dispatch" FOREIGN KEY ("dispatch_id") REFERENCES "marketing_broadcast_dispatches"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_dispatch_costs" ADD CONSTRAINT "FK_marketing_dispatch_costs_pricing" FOREIGN KEY ("pricing_id") REFERENCES "mail_provider_pricing"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_automation_replays" ADD CONSTRAINT "FK_marketing_automation_replays_automation" FOREIGN KEY ("automation_id") REFERENCES "marketing_automations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_automation_replays" ADD CONSTRAINT "FK_marketing_automation_replays_enrollment" FOREIGN KEY ("enrollment_id") REFERENCES "marketing_automation_enrollments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_automation_replays" ADD CONSTRAINT "FK_marketing_automation_replays_step_run" FOREIGN KEY ("step_run_id") REFERENCES "marketing_automation_step_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_quarantine_decisions" ADD CONSTRAINT "FK_mail_quarantine_decisions_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_quarantine_decisions" ADD CONSTRAINT "FK_mail_quarantine_decisions_message" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_quarantine_decisions" ADD CONSTRAINT "FK_mail_quarantine_decisions_attachment" FOREIGN KEY ("attachment_id") REFERENCES "mail_attachments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_message_provider_ids" ADD CONSTRAINT "FK_mail_message_provider_ids_message" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- CHECK constraints (not expressible in the Prisma schema).
ALTER TABLE "marketing_template_policies" ADD CONSTRAINT "CHK_marketing_template_policies_class"
  CHECK ("classification" IN ('MARKETING', 'TRANSACTIONAL', 'TRANSACTIONAL_SECURITY'));
ALTER TABLE "marketing_template_version_policies" ADD CONSTRAINT "CHK_marketing_template_version_policies_class"
  CHECK ("classification" IN ('MARKETING', 'TRANSACTIONAL', 'TRANSACTIONAL_SECURITY'));
ALTER TABLE "marketing_contact_provider_states" ADD CONSTRAINT "CHK_marketing_contact_provider_states_state"
  CHECK ("state" IN ('SUBSCRIBED', 'UNSUBSCRIBED', 'SUPPRESSED', 'UNKNOWN'));
ALTER TABLE "marketing_provider_resubscriptions" ADD CONSTRAINT "CHK_marketing_provider_resubscriptions_status"
  CHECK ("status" IN ('PENDING_APPROVAL', 'APPROVED', 'APPLIED', 'UNSUPPORTED', 'FAILED', 'REFUSED', 'CANCELLED'));
ALTER TABLE "marketing_provider_resubscriptions" ADD CONSTRAINT "CHK_marketing_provider_resubscriptions_attempts"
  CHECK ("attempts" >= 0);
ALTER TABLE "mail_provider_pricing" ADD CONSTRAINT "CHK_mail_provider_pricing_values"
  CHECK ("unit_cost_micros" >= 0 AND ("included_monthly" IS NULL OR "included_monthly" >= 0)
     AND ("effective_to" IS NULL OR "effective_to" > "effective_from")
     AND "currency" ~ '^[A-Z]{3}$'
     AND "source" IN ('CONTRACT', 'PRICE_LIST', 'INVOICE'));
ALTER TABLE "mail_provider_quota_observations" ADD CONSTRAINT "CHK_mail_provider_quota_observations_values"
  CHECK ("source" IN ('RESPONSE_HEADER', 'QUOTA_ERROR', 'CONFIGURED_LIMIT')
     AND ("exhausted_kind" IS NULL OR "exhausted_kind" IN ('DAILY', 'MONTHLY'))
     AND COALESCE("daily_used", 0) >= 0 AND COALESCE("monthly_used", 0) >= 0);
ALTER TABLE "marketing_dispatch_costs" ADD CONSTRAINT "CHK_marketing_dispatch_costs_values"
  CHECK ("status" IN ('ESTIMATED', 'UNAVAILABLE') AND "basis_count" >= 0
     AND ("status" = 'UNAVAILABLE' OR ("estimated_cost_micros" IS NOT NULL AND "currency" IS NOT NULL AND "pricing_id" IS NOT NULL)));
ALTER TABLE "marketing_automation_replays" ADD CONSTRAINT "CHK_marketing_automation_replays_values"
  CHECK ("scope" IN ('STEP_RUN', 'ENROLLMENT', 'DEAD_LETTER_JOB')
     AND "mode" IN ('DRY_RUN', 'EXECUTE')
     AND "status" IN ('PLANNED', 'EXECUTED', 'REFUSED', 'FAILED'));
ALTER TABLE "mail_storage_deletions" ADD CONSTRAINT "CHK_mail_storage_deletions_values"
  CHECK ("status" IN ('PENDING', 'RUNNING', 'DONE', 'DEAD', 'CANCELLED') AND "attempts" >= 0);
ALTER TABLE "mail_quarantine_decisions" ADD CONSTRAINT "CHK_mail_quarantine_decisions_values"
  CHECK ("target_type" IN ('MESSAGE', 'ATTACHMENT')
     AND "decision" IN ('RELEASED', 'REJECTED', 'RESCAN_REQUESTED', 'DELETED')
     AND (("target_type" = 'MESSAGE' AND "message_id" IS NOT NULL) OR ("target_type" = 'ATTACHMENT' AND "attachment_id" IS NOT NULL)));

-- One open re-subscription per contact and topic.
CREATE UNIQUE INDEX "UQ_marketing_provider_resubscriptions_open"
  ON "marketing_provider_resubscriptions"("contact_id", "topic")
  WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED');
-- A step run is replayed for real at most once.
CREATE UNIQUE INDEX "UQ_marketing_automation_replays_executed_step"
  ON "marketing_automation_replays"("step_run_id")
  WHERE "mode" = 'EXECUTE' AND "status" = 'EXECUTED' AND "step_run_id" IS NOT NULL;
-- One open deletion per object.
CREATE UNIQUE INDEX "UQ_mail_storage_deletions_open_object"
  ON "mail_storage_deletions"("object_key")
  WHERE "status" IN ('PENDING', 'RUNNING');

-- Evidence tables are append-only (same guard as the other Mail evidence).
CREATE TRIGGER "TRG_marketing_template_version_policies_immutable"
  BEFORE UPDATE OR DELETE ON "marketing_template_version_policies"
  FOR EACH ROW EXECUTE FUNCTION prevent_mail_evidence_mutation();
CREATE TRIGGER "TRG_mail_quarantine_decisions_append_only"
  BEFORE UPDATE OR DELETE ON "mail_quarantine_decisions"
  FOR EACH ROW EXECUTE FUNCTION mail_guard_append_only();
