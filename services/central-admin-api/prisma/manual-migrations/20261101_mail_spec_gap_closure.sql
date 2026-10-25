-- CosmicForge Mail: specification gap closure (M1-M10 final pass).
-- Additive only; NEW TABLES ONLY. No existing table gains a column, so code
-- deployed before this migration never selects anything that is missing, and
-- the features below answer 503 MAIL_FEATURE_NOT_READY until it is applied.
--   mail_message_search_index  keyed blind index for body search (5.1, 12)
--   mail_message_archives      encrypted original headers / raw MIME (10.6)
--   mail_forwarding_rules      approved, audited forwarding (5.3, 5.4, 10.5)
--   mail_rate_limit_buckets    cross-replica rate limits (19.5, 20)
--   marketing_campaign_replies evidence-based "replied" metric (13.3)
-- Rollback: docs/sql/cosmicforge-mail-gap-closure-rollback.sql.
-- CreateTable
CREATE TABLE "mail_message_search_index" (
    "message_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "key_version" VARCHAR(16) NOT NULL,
    "terms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "term_count" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_message_search_index_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "mail_message_archives" (
    "message_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "headers_object_key" VARCHAR(512),
    "headers_sha256" CHAR(64),
    "header_count" INTEGER NOT NULL DEFAULT 0,
    "raw_mime_status" VARCHAR(24) NOT NULL,
    "raw_mime_object_key" VARCHAR(512),
    "raw_mime_sha256" CHAR(64),
    "raw_mime_size_bytes" INTEGER,
    "archived_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_message_archives_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "mail_forwarding_rules" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "target_address" VARCHAR(320) NOT NULL,
    "target_kind" VARCHAR(16) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
    "reason" VARCHAR(500) NOT NULL,
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(500),
    "disabled_by" TEXT,
    "disabled_at" TIMESTAMPTZ(6),
    "disabled_reason" VARCHAR(64),
    "last_forwarded_at" TIMESTAMPTZ(6),
    "forwarded_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_forwarding_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_rate_limit_buckets" (
    "key" VARCHAR(200) NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PK_mail_rate_limit_buckets" PRIMARY KEY ("key","window_start")
);

-- CreateTable
CREATE TABLE "marketing_campaign_replies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "dispatch_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "mail_message_id" UUID NOT NULL,
    "method" VARCHAR(32) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_campaign_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IDX_mail_message_search_index_mailbox" ON "mail_message_search_index"("mailbox_id", "indexed_at");

-- CreateIndex
CREATE INDEX "IDX_mail_message_search_index_terms" ON "mail_message_search_index" USING GIN ("terms" array_ops);

-- CreateIndex
CREATE INDEX "IDX_mail_message_archives_mailbox" ON "mail_message_archives"("mailbox_id");

-- CreateIndex
CREATE INDEX "IDX_mail_forwarding_rules_mailbox_status" ON "mail_forwarding_rules"("mailbox_id", "status");

-- CreateIndex
CREATE INDEX "IDX_mail_forwarding_rules_status" ON "mail_forwarding_rules"("status", "requested_at");

-- CreateIndex
CREATE INDEX "IDX_mail_rate_limit_buckets_expires" ON "mail_rate_limit_buckets"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_campaign_replies_recipient" ON "marketing_campaign_replies"("recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_campaign_replies_message" ON "marketing_campaign_replies"("mail_message_id");

-- CreateIndex
CREATE INDEX "IDX_marketing_campaign_replies_campaign" ON "marketing_campaign_replies"("campaign_id", "received_at");

-- AddForeignKey
ALTER TABLE "mail_message_search_index" ADD CONSTRAINT "FK_mail_message_search_index_message" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_message_archives" ADD CONSTRAINT "FK_mail_message_archives_message" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_forwarding_rules" ADD CONSTRAINT "FK_mail_forwarding_rules_mailbox" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_campaign_replies" ADD CONSTRAINT "FK_marketing_campaign_replies_campaign" FOREIGN KEY ("campaign_id") REFERENCES "marketing_email_campaigns"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_campaign_replies" ADD CONSTRAINT "FK_marketing_campaign_replies_recipient" FOREIGN KEY ("recipient_id") REFERENCES "marketing_broadcast_recipients"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_campaign_replies" ADD CONSTRAINT "FK_marketing_campaign_replies_message" FOREIGN KEY ("mail_message_id") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Integrity rules Prisma cannot express.
ALTER TABLE "mail_message_search_index"
  ADD CONSTRAINT "CHK_mail_message_search_index_counts" CHECK ("term_count" >= 0 AND "term_count" <= 4000 AND COALESCE(cardinality("terms"), 0) = "term_count");
ALTER TABLE "mail_message_archives"
  ADD CONSTRAINT "CHK_mail_message_archives_raw_status" CHECK ("raw_mime_status" IN ('STORED', 'NOT_REQUESTED', 'UNAVAILABLE', 'TOO_LARGE', 'FAILED')),
  ADD CONSTRAINT "CHK_mail_message_archives_raw_stored" CHECK (("raw_mime_status" = 'STORED') = ("raw_mime_object_key" IS NOT NULL AND "raw_mime_sha256" IS NOT NULL)),
  ADD CONSTRAINT "CHK_mail_message_archives_sha" CHECK (("headers_sha256" IS NULL OR "headers_sha256" ~ '^[0-9a-f]{64}$') AND ("raw_mime_sha256" IS NULL OR "raw_mime_sha256" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "mail_forwarding_rules"
  ADD CONSTRAINT "CHK_mail_forwarding_rules_kind" CHECK ("target_kind" IN ('INTERNAL', 'EXTERNAL')),
  ADD CONSTRAINT "CHK_mail_forwarding_rules_status" CHECK ("status" IN ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'DISABLED')),
  ADD CONSTRAINT "CHK_mail_forwarding_rules_target" CHECK ("target_address" = lower("target_address") AND "target_address" LIKE '%_@_%'),
  ADD CONSTRAINT "CHK_mail_forwarding_rules_decision" CHECK ("status" = 'PENDING_APPROVAL' OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL) OR "status" = 'DISABLED'),
  ADD CONSTRAINT "CHK_mail_forwarding_rules_disabled" CHECK ("status" <> 'DISABLED' OR "disabled_at" IS NOT NULL),
  ADD CONSTRAINT "CHK_mail_forwarding_rules_count" CHECK ("forwarded_count" >= 0);
-- At most one pending/active rule per mailbox and target.
CREATE UNIQUE INDEX "UQ_mail_forwarding_rules_live" ON "mail_forwarding_rules"("mailbox_id", "target_address") WHERE "status" IN ('PENDING_APPROVAL', 'ACTIVE');
ALTER TABLE "mail_rate_limit_buckets"
  ADD CONSTRAINT "CHK_mail_rate_limit_buckets_count" CHECK ("count" >= 0),
  ADD CONSTRAINT "CHK_mail_rate_limit_buckets_expiry" CHECK ("expires_at" > "window_start");
ALTER TABLE "marketing_campaign_replies"
  ADD CONSTRAINT "CHK_marketing_campaign_replies_method" CHECK ("method" IN ('RECIPIENT_REPLY_ADDRESS_MATCH'));
