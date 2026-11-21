// CF Meet section pages (design §10). Each page shows one or more Product
// Admin modules with a fixed read purpose; the purpose is part of every read
// and is audited by CF Meet Admin. Verification is not here: it has its own
// generalized page for every product.

import type { ReadPurpose } from "./catalog";

export interface CfMeetSectionDef {
  id: string;
  label: string;
  /** Product Admin modules shown on this page (catalog `modules[].module`). */
  modules: string[];
  purpose: ReadPurpose;
  /** Report ids without the "cfmeet.report." prefix. */
  reports: string[];
  description: string;
}

export const OVERVIEW_SECTION = "overview";

export const CFMEET_SECTIONS: readonly CfMeetSectionDef[] = [
  { id: "users", label: "Users", modules: ["accounts"], purpose: "support-review", reports: [], description: "CF Meet accounts: users, sessions, devices, security history and duplicates." },
  { id: "meetings", label: "Meetings", modules: ["meetings"], purpose: "support-review", reports: ["meeting_activity"], description: "Spaces, meetings, live meetings, participants, recordings, webinars and meeting reports. No media or transcripts content." },
  { id: "chat-safety", label: "Chat safety", modules: ["messaging"], purpose: "abuse-review", reports: ["safety_queue"], description: "Message reports, moderation, holds, exports, deletion requests and off-switches. Encrypted content is never readable by HQ." },
  { id: "calls", label: "Calls", modules: ["calling"], purpose: "abuse-review", reports: [], description: "Calls, live calls, abuse reports, blocks, limits, spend, routing and incidents. No call audio." },
  { id: "profiles", label: "Profiles", modules: ["communications"], purpose: "support-review", reports: ["communications_metrics"], description: "Communications profiles, reports, holds and audit." },
  { id: "organizations", label: "Organizations", modules: ["organizations"], purpose: "support-review", reports: [], description: "Organizations, members, teams, policies, bindings and audit." },
  { id: "partners", label: "Partners", modules: ["partners", "identity"], purpose: "support-review", reports: ["partner_workspaces", "partner_usage"], description: "Partner workspaces, projects, environments, key metadata, users, webhooks and usage; identity tenants and apps." },
  { id: "apps", label: "Apps", modules: ["apps"], purpose: "support-review", reports: [], description: "Apps, versions and installs." },
  { id: "pricing", label: "Pricing", modules: ["pricing"], purpose: "pricing-change", reports: [], description: "Price books, versions, activations, freezes, Free/Pro/Business plans, plan assignments and overrides." },
  { id: "finance", label: "Finance", modules: ["finance"], purpose: "billing-review", reports: ["finance_usage", "estimated_charges", "plan_spread"], description: "Usage, estimated charges and plan spread. Money is in minor units per currency and never combined across currencies." },
  { id: "notifications", label: "Notifications", modules: ["notifications"], purpose: "ops-incident", reports: [], description: "Deliveries, failed deliveries, suppressions, routing and providers. No message content." },
  { id: "privacy", label: "Privacy", modules: ["privacy"], purpose: "privacy-request", reports: [], description: "Privacy requests and their per-service status." },
  { id: "operations", label: "Operations", modules: ["operations"], purpose: "ops-incident", reports: ["operations_health", "incidents", "connector_health", "sync_lag", "quarantine_reconciliation"], description: "Service health, incidents, switches, feature switch-on requests and release history." },
  { id: "audit", label: "Audit", modules: ["audit"], purpose: "support-review", reports: [], description: "One search across CF Meet owner audit. Read only." },
];

export const SECTION_IDS: readonly string[] = [OVERVIEW_SECTION, ...CFMEET_SECTIONS.map((s) => s.id)];

export function sectionById(id: string | null | undefined): CfMeetSectionDef | null {
  return CFMEET_SECTIONS.find((s) => s.id === id) ?? null;
}
