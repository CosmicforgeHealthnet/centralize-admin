function canAccessRestrictedEntity({
  restrictedVisibility,
  hasInboxAccess,
  hasRestrictedView,
  hasRestrictedEdit,
  hasSafetyEdit,
  requestedOperation = "VIEW",
} = {}) {
  const operation = String(requestedOperation || "VIEW").toUpperCase();

  if (operation === "SAFETY") {
    return {
      allowed: Boolean(hasSafetyEdit),
      reasonCode: hasSafetyEdit ? null : "SAFETY_EDIT_REQUIRED",
      requiredMode: "EDIT",
      requiredSection: "social_moderation_safety",
    };
  }

  if (!restrictedVisibility) {
    return {
      allowed: Boolean(hasInboxAccess),
      reasonCode: hasInboxAccess ? null : "INBOX_ACCESS_REQUIRED",
      requiredMode: operation === "VIEW" ? "VIEW" : "EDIT",
      requiredSection: "social_inbox",
    };
  }

  if (operation === "VIEW") {
    return {
      allowed: Boolean(hasRestrictedView || hasRestrictedEdit),
      reasonCode:
        hasRestrictedView || hasRestrictedEdit ? null : "RESTRICTED_VIEW_REQUIRED",
      requiredMode: "VIEW",
      requiredSection: "social_moderation_restricted",
    };
  }

  return {
    allowed: Boolean(hasRestrictedEdit),
    reasonCode: hasRestrictedEdit ? null : "RESTRICTED_EDIT_REQUIRED",
    requiredMode: "EDIT",
    requiredSection: "social_moderation_restricted",
  };
}

module.exports = {
  canAccessRestrictedEntity,
};
