const SOCIAL_OPERATION_SECTIONS = Object.freeze({
  SOCIAL_CONTENT: "social_content",
  SOCIAL_CONTENT_SUBMIT: "social_content_submit",
  SOCIAL_APPROVALS: "social_approvals",
  SOCIAL_PUBLISH: "social_publish",
  SOCIAL_PUBLISH_EMERGENCY_OVERRIDE: "social_publish_emergency_override",
  SOCIAL_SCHEDULE: "social_schedule",
  SOCIAL_PUBLISH_RETRY: "social_publish_retry",
  SOCIAL_PUBLISH_CANCEL: "social_publish_cancel",
  SOCIAL_PUBLISH_DELETE: "social_publish_delete",
  SOCIAL_INBOX: "social_inbox",
  SOCIAL_INBOX_REPLY: "social_inbox_reply",
  SOCIAL_INBOX_ASSIGN: "social_inbox_assign",
  SOCIAL_INBOX_RESOLVE: "social_inbox_resolve",
  SOCIAL_INBOX_NOTE: "social_inbox_note",
  SOCIAL_INBOX_TAG: "social_inbox_tag",
  SOCIAL_MODERATION_HIDE: "social_moderation_hide",
  SOCIAL_MODERATION_DELETE: "social_moderation_delete",
  SOCIAL_MODERATION_ESCALATE: "social_moderation_escalate",
  SOCIAL_MODERATION_SAFETY: "social_moderation_safety",
  SOCIAL_MODERATION_RESTRICTED: "social_moderation_restricted",
  SOCIAL_CONNECTIONS: "social_connections",
  SOCIAL_ANALYTICS: "social_analytics",
  SOCIAL_SETTINGS: "social_settings",
  SOCIAL_OPERATIONS: "social_operations",
});

const SOCIAL_OPERATION_SECTION_VALUES = Object.freeze(
  Object.values(SOCIAL_OPERATION_SECTIONS),
);

module.exports = {
  SOCIAL_OPERATION_SECTIONS,
  SOCIAL_OPERATION_SECTION_VALUES,
};
