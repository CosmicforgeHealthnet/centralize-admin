-- Marketing Intelligence Phase 2, Section 9: additive scoring states.
ALTER TYPE "marketing_creative_data_sufficiency_enum" ADD VALUE IF NOT EXISTS 'STRONG';
ALTER TYPE "marketing_creative_fatigue_status_enum" ADD VALUE IF NOT EXISTS 'NONE';
ALTER TYPE "marketing_creative_fatigue_status_enum" ADD VALUE IF NOT EXISTS 'RECOVERED';
