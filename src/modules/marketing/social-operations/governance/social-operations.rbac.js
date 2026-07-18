const { SOCIAL_OPERATION_SECTIONS } = require("./social-operations.sections");

const SOCIAL_OPERATION_MODULE = "marketing";
const SOCIAL_RBAC_MODES = Object.freeze(["VIEW", "EDIT"]);

const SOCIAL_OPERATION_ACTIONS = Object.freeze({
  CONTENT_VIEW: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_CONTENT,
    mode: "VIEW",
  },
  CONTENT_CREATE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_CONTENT,
    mode: "EDIT",
  },
  CONTENT_EDIT: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_CONTENT,
    mode: "EDIT",
  },
  CONTENT_SUBMIT: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_CONTENT_SUBMIT,
    mode: "EDIT",
  },
  APPROVAL_VIEW: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_APPROVALS,
    mode: "VIEW",
  },
  APPROVAL_DECIDE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_APPROVALS,
    mode: "EDIT",
  },
  PUBLISH: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_PUBLISH,
    mode: "EDIT",
  },
  PUBLISH_EMERGENCY_OVERRIDE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_PUBLISH_EMERGENCY_OVERRIDE,
    mode: "EDIT",
  },
  SCHEDULE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_SCHEDULE,
    mode: "EDIT",
  },
  PUBLISH_RETRY: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_PUBLISH_RETRY,
    mode: "EDIT",
  },
  PUBLISH_CANCEL: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_PUBLISH_CANCEL,
    mode: "EDIT",
  },
  PUBLISH_DELETE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_PUBLISH_DELETE,
    mode: "EDIT",
  },
  INBOX_VIEW: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_INBOX,
    mode: "VIEW",
  },
  INBOX_REPLY: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_INBOX_REPLY,
    mode: "EDIT",
  },
  INBOX_ASSIGN: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_INBOX_ASSIGN,
    mode: "EDIT",
  },
  INBOX_RESOLVE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_INBOX_RESOLVE,
    mode: "EDIT",
  },
  INBOX_NOTE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_INBOX_NOTE,
    mode: "EDIT",
  },
  INBOX_TAG: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_INBOX_TAG,
    mode: "EDIT",
  },
  MODERATION_HIDE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_HIDE,
    mode: "EDIT",
  },
  MODERATION_DELETE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_DELETE,
    mode: "EDIT",
  },
  MODERATION_ESCALATE: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_ESCALATE,
    mode: "EDIT",
  },
  MODERATION_SAFETY: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_SAFETY,
    mode: "EDIT",
  },
  RESTRICTED_CONTENT_VIEW: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_RESTRICTED,
    mode: "VIEW",
  },
  RESTRICTED_CONTENT_EDIT: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_RESTRICTED,
    mode: "EDIT",
  },
  CONNECTION_VIEW: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_CONNECTIONS,
    mode: "VIEW",
  },
  CONNECTION_EDIT: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_CONNECTIONS,
    mode: "EDIT",
  },
  ANALYTICS_VIEW: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_ANALYTICS,
    mode: "VIEW",
  },
  SETTINGS_VIEW: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_SETTINGS,
    mode: "VIEW",
  },
  SETTINGS_EDIT: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_SETTINGS,
    mode: "EDIT",
  },
  OPERATIONS_VIEW: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_OPERATIONS,
    mode: "VIEW",
  },
  OPERATIONS_EDIT: {
    module: SOCIAL_OPERATION_MODULE,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_OPERATIONS,
    mode: "EDIT",
  },
});

function getSocialOperationGrant(action) {
  const grant = SOCIAL_OPERATION_ACTIONS[action];
  if (!grant) {
    throw new Error(`Unknown Social Operations action: ${action}`);
  }

  if (!SOCIAL_RBAC_MODES.includes(grant.mode)) {
    throw new Error(`Unsupported Social Operations RBAC mode: ${grant.mode}`);
  }

  return grant;
}

function loadRequireSection() {
  return require("../../../../shared/middlewares/rbac.middleware").requireSection;
}

function createRequireSocialOperation(requireSectionImpl) {
  return function requireSocialOperation(action) {
    const grant = getSocialOperationGrant(action);
    const middlewareFactory = requireSectionImpl || loadRequireSection();
    return middlewareFactory(grant.module, grant.section, grant.mode);
  };
}

const requireSocialOperation = createRequireSocialOperation();

module.exports = {
  SOCIAL_OPERATION_MODULE,
  SOCIAL_RBAC_MODES,
  SOCIAL_OPERATION_ACTIONS,
  getSocialOperationGrant,
  createRequireSocialOperation,
  requireSocialOperation,
};
