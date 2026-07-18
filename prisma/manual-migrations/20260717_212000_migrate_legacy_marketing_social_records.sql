-- Section 14: idempotent legacy marketing social record backfill.
-- Additive local migration only; previous migrations and legacy rows remain unchanged.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('social_operations_legacy_marketing_social_backfill'));

DO $$
BEGIN
  IF to_regclass('public.marketing_social_posts') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table: marketing_social_posts';
  END IF;
  IF to_regclass('public.social_posts') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table: social_posts';
  END IF;
  IF to_regclass('public.social_post_revisions') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table: social_post_revisions';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    WHERE enumtypid = '"SocialPostStatus"'::regtype
      AND enumlabel IN ('LEGACY_PUBLISHED_UNVERIFIED', 'LEGACY_SCHEDULED_UNVERIFIED')
    GROUP BY enumtypid
    HAVING COUNT(*) = 2
  ) THEN
    RAISE EXCEPTION 'Required legacy SocialPostStatus values are missing';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "social_posts_legacy_source_id_unique"
  ON "social_posts"("legacy_source_id")
  WHERE "legacy_source_id" IS NOT NULL;

WITH eligible_legacy AS (
  SELECT
    legacy."id" AS legacy_source_id,
    NULL::text AS resolved_created_by_id,
    NULLIF(left(legacy."caption", 120), '') AS title,
    COALESCE(NULLIF(legacy."caption", ''), '(legacy social post had no text)') AS base_text,
    CASE
      WHEN legacy."scheduledFor" > statement_timestamp() AND legacy."postedAt" IS NULL
        THEN 'LEGACY_SCHEDULED_UNVERIFIED'::"SocialPostStatus"
      WHEN legacy."postedAt" IS NOT NULL OR legacy."status"::text = 'Published'
        THEN 'LEGACY_PUBLISHED_UNVERIFIED'::"SocialPostStatus"
      ELSE 'DRAFT'::"SocialPostStatus"
    END AS mapped_status,
    COALESCE(legacy."createdAt", statement_timestamp()) AS created_at,
    COALESCE(legacy."updatedAt", legacy."createdAt", statement_timestamp()) AS updated_at,
    legacy."platform"::text AS legacy_provider,
    legacy."status"::text AS legacy_status,
    legacy."postedAt" AS legacy_posted_at,
    legacy."scheduledFor" AS legacy_scheduled_at
  FROM "marketing_social_posts" legacy
),
insertable AS (
  SELECT eligible_legacy.*
  FROM eligible_legacy
  JOIN "admin_users" admin_user
    ON admin_user."id" = eligible_legacy.resolved_created_by_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM "social_posts" existing
    WHERE existing."legacy_source_id" = eligible_legacy.legacy_source_id
  )
),
inserted_posts AS (
  INSERT INTO "social_posts" (
    "title",
    "status",
    "created_by_id",
    "current_version",
    "legacy_source_id",
    "created_at",
    "updated_at"
  )
  SELECT
    insertable.title,
    insertable.mapped_status,
    insertable.resolved_created_by_id,
    1,
    insertable.legacy_source_id,
    insertable.created_at,
    insertable.updated_at
  FROM insertable
  RETURNING "id", "legacy_source_id"
)
INSERT INTO "social_post_revisions" (
  "post_id",
  "version",
  "title",
  "base_text",
  "snapshot_json",
  "change_summary",
  "created_by_id",
  "created_at"
)
SELECT
  inserted_posts."id",
  1,
  insertable.title,
  insertable.base_text,
  jsonb_build_object(
    'migrationSource', 'LEGACY_MARKETING_SOCIAL',
    'legacySourceId', insertable.legacy_source_id,
    'legacyStatus', insertable.legacy_status,
    'legacyPostedAt', insertable.legacy_posted_at,
    'legacyScheduledAt', insertable.legacy_scheduled_at,
    'legacyProvider', insertable.legacy_provider,
    'mediaReferences', jsonb_build_array(),
    'providerConfirmation', false
  ),
  'Initial legacy marketing social migration snapshot',
  insertable.resolved_created_by_id,
  insertable.updated_at
FROM inserted_posts
JOIN insertable
  ON insertable.legacy_source_id = inserted_posts."legacy_source_id"
WHERE NOT EXISTS (
  SELECT 1
  FROM "social_post_revisions" existing_revision
  WHERE existing_revision."post_id" = inserted_posts."id"
    AND existing_revision."version" = 1
);

COMMIT;
