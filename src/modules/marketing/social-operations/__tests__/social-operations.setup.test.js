const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const moduleRoot = path.resolve(__dirname, "..");
const schemaPath = path.resolve(__dirname, "../../../../../prisma/schema.prisma");

const REQUIRED_DIRECTORIES = [
  "accounts",
  "oauth",
  "connectors",
  "content",
  "media",
  "approvals",
  "publishing",
  "actions",
  "inbox",
  "community",
  "webhooks",
  "analytics",
  "scheduling",
  "settings",
];

const REQUIRED_ENUMS = {
  SocialProvider: ["META", "TIKTOK", "X", "LINKEDIN"],
  SocialIdentityType: [
    "FACEBOOK_PAGE",
    "INSTAGRAM_PROFESSIONAL",
    "TIKTOK_ACCOUNT",
    "X_USER",
    "LINKEDIN_ORGANIZATION",
    "LINKEDIN_MEMBER",
  ],
  SocialConnectionStatus: [
    "PENDING_AUTHORIZATION",
    "PENDING_PLATFORM_APPROVAL",
    "ACTIVE",
    "DISABLED",
    "ERROR",
    "REAUTHORIZATION_REQUIRED",
  ],
  SocialPostStatus: [
    "DRAFT",
    "PENDING_APPROVAL",
    "APPROVED",
    "REJECTED",
    "SCHEDULED",
    "PUBLISHING",
    "PARTIALLY_PUBLISHED",
    "PUBLISHED",
    "FAILED",
    "CANCELLED",
    "ARCHIVED",
    "LEGACY_PUBLISHED_UNVERIFIED",
    "LEGACY_SCHEDULED_UNVERIFIED",
  ],
  SocialTargetStatus: [
    "DRAFT",
    "PENDING_APPROVAL",
    "APPROVED",
    "SCHEDULED",
    "PUBLISHING",
    "PUBLISHED",
    "FAILED",
    "CANCELLED",
  ],
  SocialPublicationStatus: [
    "PENDING",
    "VALIDATING",
    "UPLOADING",
    "PROCESSING",
    "PUBLISHING",
    "AWAITING_USER_ACTION",
    "PUBLISHED",
    "FAILED_RETRYABLE",
    "FAILED_PERMANENT",
    "CANCELLED",
    "DELETED",
  ],
  SocialJobStatus: [
    "PENDING",
    "CLAIMED",
    "RUNNING",
    "RETRY_SCHEDULED",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
  ],
  SocialActionJobType: [
    "POLL_PUBLICATION",
    "DELETE_PROVIDER_POST",
    "SEND_MESSAGE",
    "REPLY_COMMENT",
    "HIDE_COMMENT",
    "DELETE_COMMENT",
    "SYNC_PROVIDER_CONTENT",
    "SYNC_COMMENTS",
    "SYNC_MESSAGES",
    "SYNC_METRICS",
  ],
  SocialActionStatus: [
    "PENDING",
    "CLAIMED",
    "RUNNING",
    "RETRY_SCHEDULED",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
  ],
  SocialApprovalDecision: [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "CHANGES_REQUESTED",
  ],
  SocialConversationStatus: [
    "OPEN",
    "PENDING",
    "SNOOZED",
    "RESOLVED",
    "SPAM",
    "ARCHIVED",
  ],
  SocialMessageDirection: ["INBOUND", "OUTBOUND"],
  SocialMessageType: ["TEXT", "ATTACHMENT", "TEMPLATE"],
  SocialMessageStatus: ["QUEUED", "SENT", "DELIVERED", "READ", "FAILED"],
  SocialCommentDirection: ["INBOUND", "OUTBOUND"],
  SocialModerationStatus: ["VISIBLE", "HIDDEN", "DELETED", "FLAGGED", "ESCALATED"],
  SocialEngagementType: ["REACTION", "MENTION", "FOLLOW", "OTHER"],
  SocialSensitiveDataState: [
    "UNCLASSIFIED",
    "CLEAR",
    "FLAGGED",
    "CONFIRMED",
    "REDACTED",
  ],
  SocialEscalationClassification: [
    "MEDICAL_EMERGENCY",
    "SELF_HARM_RISK",
    "CLINICAL_ADVICE_REQUEST",
    "PRESCRIPTION_REQUEST",
    "PROTECTED_HEALTH_INFORMATION",
    "PRIVACY_INCIDENT",
    "PATIENT_COMPLAINT",
    "LEGAL_THREAT",
    "MEDICAL_MISINFORMATION",
    "GENERAL_INQUIRY",
  ],
  SocialEscalationStatus: ["DETECTED", "CONFIRMED", "DISMISSED", "RESOLVED"],
  SocialWebhookStatus: [
    "RECEIVED",
    "PROCESSING",
    "PROCESSED",
    "FAILED",
    "IGNORED_DUPLICATE",
  ],
  SocialWebhookSubscriptionStatus: ["ACTIVE", "DEGRADED", "UNSUBSCRIBED", "ERROR"],
  SocialAssetStatus: ["UPLOADING", "PROCESSING", "READY", "FAILED", "DELETED"],
  SocialPostingMode: ["DIRECT_POST", "UPLOAD_TO_DRAFT"],
  SocialProviderContentSource: ["ADMIN_PUBLISHED", "PROVIDER_IMPORTED"],
  SocialProviderContentType: [
    "TEXT",
    "IMAGE",
    "VIDEO",
    "CAROUSEL",
    "REEL",
    "STORY",
    "LINK",
    "DOCUMENT",
    "OTHER",
  ],
};

function enumValues(schema, enumName) {
  const match = schema.match(new RegExp(`enum ${enumName} \\{([\\s\\S]*?)\\}`));
  assert.ok(match, `${enumName} enum is missing`);
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

test("social operations module skeleton is import-safe", () => {
  const mod = require("..");
  assert.equal(mod.SOCIAL_OPERATIONS_MODULE.name, "social-operations");
  assert.equal(mod.SOCIAL_OPERATIONS_MODULE.routeRegistered, true);

  for (const directory of REQUIRED_DIRECTORIES) {
    assert.ok(
      fs.statSync(path.join(moduleRoot, directory)).isDirectory(),
      `${directory} directory should exist`,
    );
  }
});

test("social operations enums are present exactly as specified", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");
  assert.equal(schema.includes("SUBMITTED"), false);

  for (const [enumName, expectedValues] of Object.entries(REQUIRED_ENUMS)) {
    const occurrences = schema.match(new RegExp(`enum ${enumName} \\{`, "g")) || [];
    assert.equal(occurrences.length, 1, `${enumName} should be declared once`);
    assert.deepEqual(enumValues(schema, enumName), expectedValues);
  }
});
