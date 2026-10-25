-- CosmicForge Mail M10: production pilot and expansion readiness.
-- Additive only. Database-backed rollout rules (per environment, capability
-- and scope), pilot cohorts with membership history, and operator emergency
-- stops that need no redeploy. Nothing here enables any capability: with no
-- ALLOW rules and enforcement on, every gated capability stays off.
-- Rollback: docs/sql/cosmicforge-mail-m7-m10-rollback.sql (section M10).

-- CreateTable
CREATE TABLE "mail_rollout_cohorts" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(500),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mail_rollout_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_rollout_cohort_members" (
    "id" UUID NOT NULL,
    "cohort_id" UUID NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by" TEXT,

    CONSTRAINT "mail_rollout_cohort_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_rollout_rules" (
    "id" UUID NOT NULL,
    "environment" VARCHAR(32) NOT NULL,
    "capability" VARCHAR(48) NOT NULL,
    "scope_type" VARCHAR(16) NOT NULL,
    "scope_id" VARCHAR(128),
    "effect" VARCHAR(8) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,

    CONSTRAINT "mail_rollout_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_emergency_stops" (
    "id" UUID NOT NULL,
    "environment" VARCHAR(32) NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "organization_id" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "activated_by" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ(6) NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by" TEXT,

    CONSTRAINT "mail_emergency_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_rollout_cohorts_key" ON "mail_rollout_cohorts"("key");

-- CreateIndex
CREATE INDEX "IDX_mail_rollout_cohort_members_user" ON "mail_rollout_cohort_members"("admin_user_id", "removed_at");

-- CreateIndex
CREATE INDEX "IDX_mail_rollout_rules_lookup" ON "mail_rollout_rules"("environment", "capability", "revoked_at");

-- CreateIndex
CREATE INDEX "IDX_mail_emergency_stops_active" ON "mail_emergency_stops"("environment", "released_at");

-- AddForeignKey
ALTER TABLE "mail_rollout_cohort_members" ADD CONSTRAINT "FK_mail_rollout_cohort_members_cohort" FOREIGN KEY ("cohort_id") REFERENCES "mail_rollout_cohorts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Integrity rules the ORM cannot express.
ALTER TABLE "mail_rollout_cohorts"
  ADD CONSTRAINT "CHK_mail_rollout_cohorts_key" CHECK ("key" ~ '^[a-z][a-z0-9-]{1,63}$');
ALTER TABLE "mail_rollout_rules"
  ADD CONSTRAINT "CHK_mail_rollout_rules_environment" CHECK ("environment" IN ('development', 'test', 'staging', 'production')),
  ADD CONSTRAINT "CHK_mail_rollout_rules_capability" CHECK ("capability" IN ('STAFF_MAIL', 'SUPPORT', 'MARKETING_BROADCAST', 'MARKETING_AUTOMATION', 'MARKETING_CONFIRMATION', 'PRODUCT_INTEGRATION', 'WORKER_OUTBOUND', 'WORKER_INBOUND', 'WORKER_EVENTS', 'WORKER_MARKETING')),
  ADD CONSTRAINT "CHK_mail_rollout_rules_scope" CHECK (("scope_type" = 'ENVIRONMENT' AND "scope_id" IS NULL) OR ("scope_type" IN ('ORGANIZATION', 'DOMAIN', 'MAILBOX', 'COHORT') AND "scope_id" IS NOT NULL)),
  ADD CONSTRAINT "CHK_mail_rollout_rules_worker_scope" CHECK ("capability" NOT LIKE 'WORKER\_%' OR "scope_type" = 'ENVIRONMENT'),
  ADD CONSTRAINT "CHK_mail_rollout_rules_effect" CHECK ("effect" IN ('ALLOW', 'DENY'));
-- One active rule per (environment, capability, scope, effect).
CREATE UNIQUE INDEX "UQ_mail_rollout_rules_active" ON "mail_rollout_rules"("environment", "capability", "scope_type", COALESCE("scope_id", ''), "effect") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "UQ_mail_rollout_cohort_members_active" ON "mail_rollout_cohort_members"("cohort_id", "admin_user_id") WHERE "removed_at" IS NULL;
ALTER TABLE "mail_emergency_stops"
  ADD CONSTRAINT "CHK_mail_emergency_stops_environment" CHECK ("environment" IN ('development', 'test', 'staging', 'production')),
  ADD CONSTRAINT "CHK_mail_emergency_stops_scope" CHECK (("scope" IN ('ALL', 'MARKETING') AND "organization_id" IS NULL) OR ("scope" = 'ORGANIZATION' AND "organization_id" IS NOT NULL));
CREATE UNIQUE INDEX "UQ_mail_emergency_stops_active" ON "mail_emergency_stops"("environment", "scope", COALESCE("organization_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "released_at" IS NULL;
