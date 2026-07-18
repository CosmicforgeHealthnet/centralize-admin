function readSettingValue(settings, key) {
  if (!settings) return undefined;
  if (Array.isArray(settings)) {
    return settings.find((setting) => setting.key === key)?.valueJson;
  }
  if (Object.hasOwn(settings, key)) return settings[key];
  return undefined;
}

function settingBoolean(settings, key, fallback = false) {
  const value = readSettingValue(settings, key);
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && typeof value.enabled === "boolean") {
    return value.enabled;
  }
  return fallback;
}

function isSelfApprovalAllowed(settings) {
  return settingBoolean(settings, "social.approvals.allow_self_approval", false);
}

function providerBlocked(settings, provider) {
  const blockedProviders = readSettingValue(settings, "social.policy.blocked_providers");
  return Array.isArray(blockedProviders) && blockedProviders.includes(provider);
}

function identityBlocked(settings, identityId) {
  const blockedIdentities = readSettingValue(settings, "social.policy.blocked_identity_ids");
  return Array.isArray(blockedIdentities) && blockedIdentities.includes(identityId);
}

module.exports = {
  readSettingValue,
  settingBoolean,
  isSelfApprovalAllowed,
  providerBlocked,
  identityBlocked,
};
