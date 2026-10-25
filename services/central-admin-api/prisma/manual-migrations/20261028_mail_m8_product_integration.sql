-- CosmicForge Mail M8: product integration contracts (Karryam Go, HealthNet, ...).
-- Additive only. Products keep their own transactional mail systems; HQ only
-- stores authenticated, minimal, versioned events and normalised delivery
-- metadata (recipient as keyed hash + domain, never the address).
-- Integration shared secrets are NOT stored here (secret store / env only).
-- Rollback: docs/sql/cosmicforge-mail-m7-m10-rollback.sql (section M8).

-- CreateEnum
CREATE TYPE "MailProductIntegrationStatus" AS ENUM ('DISABLED', 'ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "mail_product_integrations" (
    "id" UUID NOT NULL,
    "product" VARCHAR(64) NOT NULL,
    "organization_id" UUID NOT NULL,
    "service_name" VARCHAR(96) NOT NULL,
    "status" "MailProductIntegrationStatus" NOT NULL DEFAULT 'DISABLED',
    "classification" VARCHAR(32) NOT NULL DEFAULT 'STANDARD',
    "contract_version" INTEGER NOT NULL DEFAULT 1,
    "allowed_event_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_trigger_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "owner_approval_reference" VARCHAR(200),
    "owner_approved_by" VARCHAR(160),
    "approved_at" TIMESTAMPTZ(6),
    "activated_by_admin_user_id" TEXT,
    "last_event_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "last_error_at" TIMESTAMPTZ(6),
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_product_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_product_sender_authorizations" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "address" VARCHAR(320) NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "granted_by" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_product_sender_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_product_integration_events" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "event_id" VARCHAR(160) NOT NULL,
    "event_type" VARCHAR(96) NOT NULL,
    "event_version" INTEGER NOT NULL,
    "correlation_id" VARCHAR(160),
    "payload_sha256" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "error_code" VARCHAR(64),
    "outcome" JSONB,
    "occurred_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mail_product_integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_product_delivery_events" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_message_id" VARCHAR(160) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_message_id" VARCHAR(255),
    "sender_address" VARCHAR(320) NOT NULL,
    "recipient_hash" CHAR(64) NOT NULL,
    "recipient_domain" VARCHAR(253) NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mail_product_delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_product_integrations_product" ON "mail_product_integrations"("product");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_product_integrations_service" ON "mail_product_integrations"("service_name");

-- CreateIndex
CREATE INDEX "IDX_mail_product_sender_authorizations_lookup" ON "mail_product_sender_authorizations"("integration_id", "address");

-- CreateIndex
CREATE INDEX "IDX_mail_product_integration_events_time" ON "mail_product_integration_events"("integration_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_product_integration_events_event" ON "mail_product_integration_events"("integration_id", "event_id");

-- CreateIndex
CREATE INDEX "IDX_mail_product_delivery_events_time" ON "mail_product_delivery_events"("integration_id", "occurred_at");

-- CreateIndex
CREATE INDEX "IDX_mail_product_delivery_events_message" ON "mail_product_delivery_events"("integration_id", "product_message_id");

-- AddForeignKey
ALTER TABLE "mail_product_sender_authorizations" ADD CONSTRAINT "FK_mail_product_sender_authorizations_integration" FOREIGN KEY ("integration_id") REFERENCES "mail_product_integrations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_product_integration_events" ADD CONSTRAINT "FK_mail_product_integration_events_integration" FOREIGN KEY ("integration_id") REFERENCES "mail_product_integrations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_product_delivery_events" ADD CONSTRAINT "FK_mail_product_delivery_events_integration" FOREIGN KEY ("integration_id") REFERENCES "mail_product_integrations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Defence in depth.
ALTER TABLE "mail_product_integrations"
  ADD CONSTRAINT "CHK_mail_product_integrations_classification" CHECK ("classification" IN ('STANDARD', 'RESTRICTED_HEALTH')),
  ADD CONSTRAINT "CHK_mail_product_integrations_product" CHECK ("product" ~ '^[a-z][a-z0-9-]{1,63}$'),
  -- HealthNet (clinical-adjacent) integrations may only ever carry low-
  -- sensitivity operational alerts: no delivery metadata, no marketing triggers.
  ADD CONSTRAINT "CHK_mail_product_integrations_restricted_health" CHECK (
    "classification" <> 'RESTRICTED_HEALTH'
    OR ("allowed_event_types" <@ ARRAY['ops.alert']::text[] AND cardinality("allowed_trigger_types") = 0)
  ),
  -- Activation needs a recorded product-owner approval.
  ADD CONSTRAINT "CHK_mail_product_integrations_active_approved" CHECK ("status" <> 'ACTIVE' OR ("owner_approval_reference" IS NOT NULL AND "approved_at" IS NOT NULL));
ALTER TABLE "mail_product_sender_authorizations"
  ADD CONSTRAINT "CHK_mail_product_sender_authorizations_purpose" CHECK ("purpose" IN ('TRANSACTIONAL', 'MARKETING_TRIGGER', 'OPERATIONAL_ALERT'));
CREATE UNIQUE INDEX "UQ_mail_product_sender_authorizations_active"
  ON "mail_product_sender_authorizations"("integration_id", "address_id", "purpose") WHERE "revoked_at" IS NULL;
ALTER TABLE "mail_product_integration_events"
  ADD CONSTRAINT "CHK_mail_product_integration_events_status" CHECK ("status" IN ('ACCEPTED', 'REJECTED'));
ALTER TABLE "mail_product_delivery_events"
  ADD CONSTRAINT "CHK_mail_product_delivery_events_status" CHECK ("status" IN ('ACCEPTED', 'DELIVERED', 'DELAYED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'SUPPRESSED')),
  ADD CONSTRAINT "CHK_mail_product_delivery_events_hash" CHECK ("recipient_hash" ~ '^[0-9a-f]{64}$');

-- Append-only evidence that only an explicit, approved retention purge may
-- delete (the M9 retention worker sets cosmicforge.mail_retention_purge=on
-- with SET LOCAL inside its own transaction). Updates are never allowed.
CREATE OR REPLACE FUNCTION mail_guard_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'mail evidence row in % is immutable', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(current_setting('cosmicforge.mail_retention_purge', true), '') <> 'on' THEN
    RAISE EXCEPTION 'mail evidence row in % can only be removed by an approved retention purge', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "TRG_mail_product_integration_events_append_only"
  BEFORE UPDATE OR DELETE ON "mail_product_integration_events"
  FOR EACH ROW EXECUTE FUNCTION mail_guard_append_only();

CREATE TRIGGER "TRG_mail_product_delivery_events_append_only"
  BEFORE UPDATE OR DELETE ON "mail_product_delivery_events"
  FOR EACH ROW EXECUTE FUNCTION mail_guard_append_only();
