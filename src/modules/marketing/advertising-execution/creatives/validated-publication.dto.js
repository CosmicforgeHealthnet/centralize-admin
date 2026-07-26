const { executionError } = require("../execution.errors");
const VALIDATED_PUBLICATION = Symbol("validated-creative-publication");

function createValidatedPublicationDto(value) {
  const required = ["creativeAssetId", "platform", "connectionId", "accountExternalId", "apiVersion", "creativeFormat", "contentHash", "contentProjection", "sourceMediaChecksum", "reuseClassification", "createdByAdminUserId"];
  if (required.some((field) => value?.[field] == null || value[field] === "")) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "VALIDATED_PUBLICATION_DTO_INCOMPLETE" });
  return Object.freeze({ ...value, [VALIDATED_PUBLICATION]: true });
}

function assertValidatedPublicationDto(value) {
  if (!value?.[VALIDATED_PUBLICATION]) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "UNVALIDATED_PUBLICATION_REPOSITORY_WRITE" });
  return value;
}

module.exports = { createValidatedPublicationDto, assertValidatedPublicationDto };
