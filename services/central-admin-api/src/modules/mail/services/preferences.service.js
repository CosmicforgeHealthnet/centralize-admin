"use strict";

// Per-user Mail preferences (spec 15 "Profiles", migration 36):
//   - preferred (default) sender identity, pre-selected in compose;
//   - Mail notification preference (in-app "new email" notices on/off).
// Signatures stay per mailbox (mailbox settings); forwarding stays a separate,
// approved request (forwarding.service.js).
//
// The preferred sender must be one of the caller's CURRENT sender identities
// (an identity is per mailbox: mailbox-owned addresses plus unexpired sender
// grants, see authz/mail.policy.js listSenderIdentities). It is re-checked on
// every read and every use, so a revoked membership or grant silently stops
// applying instead of letting the preference widen access.
//
// Before migration 36 the table is missing: reads answer the defaults
// (notifications on, no preferred sender), writes answer 503
// MAIL_FEATURE_NOT_READY and nothing is suppressed.

const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { iso } = require("./serializers");

const DEFAULTS = Object.freeze({ notificationsEnabled: true, defaultSenderAddressId: null });
const FIELDS = ["defaultSenderAddressId", "notificationsEnabled"];

function createPreferencesService({ client, feature, audit, clock = () => new Date(), logger = null }) {
  const ready = async () => Boolean(feature && (await feature.isReady()));

  async function findRow(adminUserId, tx = client) {
    if (!(await ready())) return null;
    return tx.mailUserPreference.findUnique({ where: { adminUserId } });
  }

  // Every identity the caller may send as, across mailboxes they can send from.
  async function senderOptions(user, now = clock()) {
    const memberships = await client.mailMembership.findMany({
      where: { adminUserId: user.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], canSend: true, role: { not: "READER" }, mailbox: { status: "ACTIVE" } },
      select: { mailboxId: true },
    });
    const options = new Map();
    for (const mailboxId of [...new Set(memberships.map((entry) => entry.mailboxId))]) {
      const access = await policy.resolveMailboxAccess(client, user, mailboxId, { now });
      for (const identity of await policy.listSenderIdentities(client, user, access, { now })) {
        if (options.has(identity.addressId)) continue;
        options.set(identity.addressId, { addressId: identity.addressId, address: identity.address, displayName: identity.displayName || null, kind: identity.kind, mailboxId, mailboxName: access.mailbox.name });
      }
    }
    return [...options.values()].sort((a, b) => a.address.localeCompare(b.address));
  }

  async function getPreferences(user) {
    policy.assertActiveIdentity(user);
    const available = await ready();
    const [row, options] = await Promise.all([available ? findRow(user.id) : null, senderOptions(user)]);
    const stored = row?.defaultSenderAddressId || null;
    return {
      available,
      notificationsEnabled: row ? row.notificationsEnabled : DEFAULTS.notificationsEnabled,
      // Only reported while it is still a sender identity of the caller.
      defaultSenderAddressId: stored && options.some((option) => option.addressId === stored) ? stored : null,
      senderOptions: options,
      updatedAt: iso(row?.updatedAt) || null,
    };
  }

  function parseInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw mailError("MAIL_VALIDATION_FAILED", { field: "body" });
    const unknown = Object.keys(input).filter((key) => !FIELDS.includes(key));
    if (unknown.length) throw mailError("MAIL_VALIDATION_FAILED", { field: unknown[0], reason: "UNKNOWN_FIELD" });
    const changes = {};
    if (input.notificationsEnabled !== undefined) {
      if (typeof input.notificationsEnabled !== "boolean") throw mailError("MAIL_VALIDATION_FAILED", { field: "notificationsEnabled" });
      changes.notificationsEnabled = input.notificationsEnabled;
    }
    if (input.defaultSenderAddressId !== undefined) {
      if (input.defaultSenderAddressId !== null && !policy.isUuid(input.defaultSenderAddressId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "defaultSenderAddressId" });
      changes.defaultSenderAddressId = input.defaultSenderAddressId;
    }
    if (!Object.keys(changes).length) throw mailError("MAIL_VALIDATION_FAILED", { field: "body", reason: "NO_CHANGES" });
    return changes;
  }

  async function updatePreferences(user, input, context = {}) {
    policy.assertActiveIdentity(user);
    if (!(await ready())) throw mailError("MAIL_FEATURE_NOT_READY", { feature: "preferences" });
    const changes = parseInput(input);
    if (changes.defaultSenderAddressId) {
      const options = await senderOptions(user);
      if (!options.some((option) => option.addressId === changes.defaultSenderAddressId)) throw mailError("MAIL_SENDER_NOT_AUTHORIZED", { field: "defaultSenderAddressId" });
    }
    const before = await findRow(user.id);
    await client.mailUserPreference.upsert({
      where: { adminUserId: user.id },
      create: { adminUserId: user.id, ...DEFAULTS, ...changes },
      update: changes,
    });
    // Metadata only: which fields changed and their new (non-content) values.
    await audit.record({
      actorAdminUserId: user.id,
      action: "MAIL_PREFERENCES_UPDATED",
      targetType: "mail_preferences",
      targetId: user.id,
      metadata: {
        changed: Object.keys(changes),
        ...(changes.notificationsEnabled !== undefined ? { notificationsEnabled: changes.notificationsEnabled, previousNotificationsEnabled: before ? before.notificationsEnabled : DEFAULTS.notificationsEnabled } : {}),
        ...(changes.defaultSenderAddressId !== undefined ? { defaultSenderAddressId: changes.defaultSenderAddressId, previousDefaultSenderAddressId: before?.defaultSenderAddressId || null } : {}),
      },
    }, context);
    return getPreferences(user);
  }

  // The caller's preferred sender if it is among `identities` (the identities
  // of the mailbox being composed from), else null. Never throws: a missing
  // table or a read error just means "no preference".
  async function defaultSenderFor(user, identities) {
    try {
      const row = await findRow(user.id);
      const preferred = row?.defaultSenderAddressId;
      return preferred && identities.some((identity) => identity.addressId === preferred) ? preferred : null;
    } catch (error) {
      logger?.warn?.(`[Mail] preference read failed: ${error?.code || "error"}`);
      return null;
    }
  }

  return { getPreferences, updatePreferences, defaultSenderFor, senderOptions };
}

module.exports = { createPreferencesService, PREFERENCE_DEFAULTS: DEFAULTS };
