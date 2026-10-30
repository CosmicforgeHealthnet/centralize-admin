-- Ensure PostgreSQL-only Social Operations partial unique indexes exist on the Admin database.
-- This migration is additive and safe to run after Prisma db push has created the base tables.

DO $$
DECLARE
  duplicate_groups INTEGER;
BEGIN
  IF to_regclass('public.social_webhook_subscriptions') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table: social_webhook_subscriptions';
  END IF;
  IF to_regclass('public.social_posts') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table: social_posts';
  END IF;

  SELECT COUNT(*) INTO duplicate_groups
  FROM (
    SELECT connection_id, event_type
    FROM public.social_webhook_subscriptions
    WHERE identity_id IS NULL
    GROUP BY connection_id, event_type
    HAVING COUNT(*) > 1
  ) duplicate_keys;
  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION 'Duplicate connection-level webhook subscription keys: % group(s)', duplicate_groups;
  END IF;

  SELECT COUNT(*) INTO duplicate_groups
  FROM (
    SELECT connection_id, identity_id, event_type
    FROM public.social_webhook_subscriptions
    WHERE identity_id IS NOT NULL
    GROUP BY connection_id, identity_id, event_type
    HAVING COUNT(*) > 1
  ) duplicate_keys;
  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION 'Duplicate identity-level webhook subscription keys: % group(s)', duplicate_groups;
  END IF;

  SELECT COUNT(*) INTO duplicate_groups
  FROM (
    SELECT legacy_source_id
    FROM public.social_posts
    WHERE legacy_source_id IS NOT NULL
    GROUP BY legacy_source_id
    HAVING COUNT(*) > 1
  ) duplicate_keys;
  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION 'Duplicate legacy social source keys: % group(s)', duplicate_groups;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS social_webhook_subscription_connection_event_unique
  ON public.social_webhook_subscriptions ("connection_id", "event_type")
  WHERE "identity_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS social_webhook_subscription_identity_event_unique
  ON public.social_webhook_subscriptions ("connection_id", "identity_id", "event_type")
  WHERE "identity_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS social_posts_legacy_source_id_unique
  ON public.social_posts ("legacy_source_id")
  WHERE "legacy_source_id" IS NOT NULL;
