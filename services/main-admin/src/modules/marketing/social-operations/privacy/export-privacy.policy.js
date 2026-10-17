const PRIVATE_STATES = Object.freeze(["FLAGGED", "CONFIRMED", "REDACTED"]);

function isPrivateSensitiveState(state) {
  return PRIVATE_STATES.includes(String(state || ""));
}

function isRestrictedRow(row) {
  if (!row) return false;
  if (isPrivateSensitiveState(row.sensitiveDataState)) return true;
  if (row.restrictedVisibility === true) return true;
  if (row.escalations?.some((escalation) => escalation.restrictedVisibility)) return true;
  return false;
}

function filterPrivateRows(rows) {
  return (rows || []).filter((row) => !isRestrictedRow(row));
}

function safeAnalyticsWhere(extra = {}) {
  return {
    ...extra,
    sensitiveDataState: { notIn: PRIVATE_STATES },
  };
}

function stripInternalNotesForThirdParty(value) {
  if (Array.isArray(value)) return value.map(stripInternalNotesForThirdParty);
  if (!value || typeof value !== "object") return value;
  const stripped = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "internalNotes" || key === "notes") continue;
    stripped[key] = stripInternalNotesForThirdParty(nested);
  }
  return stripped;
}

module.exports = {
  PRIVATE_STATES,
  isPrivateSensitiveState,
  isRestrictedRow,
  filterPrivateRows,
  safeAnalyticsWhere,
  stripInternalNotesForThirdParty,
};
