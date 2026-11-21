// Query shapes of the CF Meet Admin Bridge READ capabilities, copied from the
// contract pinned by services/cfmeet-admin
// (src/bridge/contracts/cfmeet-capabilities.v1.json: cfmeet-admin-bridge
// 1.2.0, source commit 568328cc, openapi sha256 7c50f191...).
//
// Only used as a fallback: the capabilities response does not carry the query
// shape yet. When a collection entry from GET /api/products/cfmeet/capabilities
// carries `query_shape`, that value wins (see catalog.ts queryShapeOf).
// Every READ capability not listed here is SCOPED_PAGE (paged list, no window,
// no search). Shapes decide which query keys the Product Admin accepts:
//   SCOPED        one object, no paging
//   SCOPED_PAGE   limit + continuation
//   SCOPED_WINDOW limit + continuation + start/end (at most 31 days)
//   SCOPED_SEARCH limit + continuation + q
// This is contract metadata, not data. Update it when the pin changes.

export type QueryShape = "SCOPED" | "SCOPED_PAGE" | "SCOPED_WINDOW" | "SCOPED_SEARCH";

export const PINNED_CONTRACT_LABEL = "cfmeet-admin-bridge 1.2.0";

export const PINNED_QUERY_SHAPES: Readonly<Record<string, QueryShape>> = Object.freeze({
  // SCOPED_SEARCH
  "accounts.users.search": "SCOPED_SEARCH",
  "meetings.spaces.search": "SCOPED_SEARCH",
  "meetings.meetings.search": "SCOPED_SEARCH",
  "organizations.organizations.search": "SCOPED_SEARCH",
  "partners.workspaces.search": "SCOPED_SEARCH",
  "partners.users.list": "SCOPED_SEARCH",
  "identity.tenants.list": "SCOPED_SEARCH",
  "identity.records.list": "SCOPED_SEARCH",
  "identity.oauth-apps.list": "SCOPED_SEARCH",
  "identity.partner-users.list": "SCOPED_SEARCH",
  "apps.apps.search": "SCOPED_SEARCH",
  "pricing.plan-assignments.list": "SCOPED_SEARCH",
  "notifications.suppressions.list": "SCOPED_SEARCH",
  // SCOPED_WINDOW
  "bridge.datasets.read": "SCOPED_WINDOW",
  "accounts.security-history.list": "SCOPED_WINDOW",
  "meetings.recordings.list": "SCOPED_WINDOW",
  "meetings.transcripts.list": "SCOPED_WINDOW",
  "meetings.webinars.list": "SCOPED_WINDOW",
  "meetings.audit.list": "SCOPED_WINDOW",
  "meetings.email-delivery.read": "SCOPED_WINDOW",
  "messaging.audit.list": "SCOPED_WINDOW",
  "messaging.incidents.list": "SCOPED_WINDOW",
  "messaging.failed-messages.list": "SCOPED_WINDOW",
  "calling.calls.list": "SCOPED_WINDOW",
  "calling.recordings.list": "SCOPED_WINDOW",
  "calling.voicemail.list": "SCOPED_WINDOW",
  "calling.incidents.list": "SCOPED_WINDOW",
  "calling.audit.list": "SCOPED_WINDOW",
  "communications.audit.list": "SCOPED_WINDOW",
  "organizations.audit.list": "SCOPED_WINDOW",
  "organizations.global-audit.list": "SCOPED_WINDOW",
  "partners.workspace-activity.list": "SCOPED_WINDOW",
  "partners.webhook-deliveries.list": "SCOPED_WINDOW",
  "partners.usage.read": "SCOPED_WINDOW",
  "partners.incidents.list": "SCOPED_WINDOW",
  "identity.audit.list": "SCOPED_WINDOW",
  "finance.usage.report": "SCOPED_WINDOW",
  "finance.estimated-charges.report": "SCOPED_WINDOW",
  "finance.plan-spread.report": "SCOPED_WINDOW",
  "notifications.deliveries.list": "SCOPED_WINDOW",
  "notifications.failed-deliveries.list": "SCOPED_WINDOW",
  "operations.incidents.list": "SCOPED_WINDOW",
  "operations.releases.list": "SCOPED_WINDOW",
  "audit.entries.list": "SCOPED_WINDOW",
  // SCOPED
  "bridge.capabilities.read": "SCOPED",
  "bridge.health.read": "SCOPED",
  "hq.projections.status": "SCOPED",
  "accounts.users.read": "SCOPED",
  "accounts.mfa.read": "SCOPED",
  "meetings.meetings.read": "SCOPED",
  "meetings.live-health.read": "SCOPED",
  "meetings.chat-migration.read": "SCOPED",
  "meetings.critical-lane.read": "SCOPED",
  "messaging.reports.read": "SCOPED",
  "messaging.policy.read": "SCOPED",
  "messaging.key-transparency.read": "SCOPED",
  "calling.calls.read": "SCOPED",
  "calling.limits.read": "SCOPED",
  "calling.routing.read": "SCOPED",
  "calling.enterprise-features.read": "SCOPED",
  "calling.spend-limits.read": "SCOPED",
  "communications.profiles.read": "SCOPED",
  "communications.metrics.read": "SCOPED",
  "organizations.organizations.read": "SCOPED",
  "organizations.policies.read": "SCOPED",
  "partners.workspaces.read": "SCOPED",
  "apps.apps.read": "SCOPED",
  "verification.cases.read": "SCOPED",
  "pricing.versions.read": "SCOPED",
  "pricing.charges.simulate": "SCOPED",
  "notifications.routing.read": "SCOPED",
  "notifications.providers.read": "SCOPED",
  "privacy.requests.read": "SCOPED",
  "operations.health.read": "SCOPED",
  "telecom.numbers.summary": "SCOPED",
  "telecom.calls.summary": "SCOPED",
  "telecom.sms.summary": "SCOPED",
  "telecom.privacy-relay.summary": "SCOPED",
});
