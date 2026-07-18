const { isSelfApprovalAllowed } = require("./governance-settings.service");

function canApprovePost({ actorId, authorId, settings } = {}) {
  if (!actorId || !authorId || actorId !== authorId) {
    return {
      allowed: true,
      reasonCode: null,
      message: null,
    };
  }

  if (isSelfApprovalAllowed(settings)) {
    return {
      allowed: true,
      reasonCode: null,
      message: null,
    };
  }

  return {
    allowed: false,
    reasonCode: "SELF_APPROVAL_DENIED",
    message: "The author cannot approve their own Social Operations submission.",
  };
}

function planApprovedTargetEdit({ target, currentRevision, changes = {} } = {}) {
  const wasApproved = ["APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED"].includes(
    target?.status,
  );

  if (!wasApproved) {
    return {
      requiresNewRevision: false,
      targetStatus: target?.status || "DRAFT",
      reapprovalRequired: false,
      previousRevision: currentRevision || null,
      changes,
    };
  }

  return {
    requiresNewRevision: true,
    targetStatus: "DRAFT",
    reapprovalRequired: true,
    previousRevision: currentRevision || null,
    changes,
  };
}

module.exports = {
  canApprovePost,
  planApprovedTargetEdit,
};
