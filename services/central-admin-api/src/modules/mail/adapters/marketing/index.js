"use strict";

// Per-brand marketing provider resolution. Resend contacts and their global
// unsubscribe flag are scoped to a Resend account, so brands must not share an
// account by default: one brand's unsubscribe would otherwise silently affect
// another brand, and contacts of different brands would be co-mingled.
//
//   RESEND_MARKETING_API_KEY__<SLUG>   brand key (slug upper-cased, - -> _)
//   RESEND_MARKETING_API_KEY           shared key, used only when
//   MAIL_BROADCAST_ALLOW_SHARED_PROVIDER_ACCOUNT=true (explicit decision)
//
// No key -> an unconfigured adapter (every call fails closed, NOT_CONFIGURED).

const { assertMarketingAdapter, unconfiguredMarketingAdapter } = require("./marketing-provider.contract");
const { createResendMarketingAdapter } = require("./resend-marketing.adapter");
const { createFakeMarketingAdapter } = require("./fake-marketing.adapter");

function brandKeyName(slug) {
  return `RESEND_MARKETING_API_KEY__${String(slug || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function resolveBrandApiKey(slug, { env = process.env, config }) {
  const own = String(env[brandKeyName(slug)] || "");
  if (own) return { apiKey: own, source: "brand" };
  if (config.broadcast.allowSharedProviderAccount && env.RESEND_MARKETING_API_KEY) return { apiKey: String(env.RESEND_MARKETING_API_KEY), source: "shared" };
  return { apiKey: "", source: "none" };
}

// Quota scope of a brand's provider account (GAP 3): a brand key is its own
// account ("brand:<slug>"); the shared key is one account for all brands.
function quotaScopeFor(slug, source) {
  if (source === "brand") return `brand:${String(slug).toLowerCase()}`.slice(0, 64);
  if (source === "shared") return "marketing-shared";
  return null;
}

// Returns (organization) -> adapter. Adapters are cached per brand.
// quotaObserver(scope, provider) -> hook, wired into real Resend adapters.
function createMarketingProviderResolver({ config, env = process.env, fetchImpl, adapter = null, adapters = null, quotaObserver = null }) {
  const cache = new Map();
  return function forOrganization(organization) {
    if (!organization?.slug) return unconfiguredMarketingAdapter("Unknown brand");
    if (adapters?.[organization.slug]) return adapters[organization.slug];
    if (adapter) return adapter; // tests: one injected adapter
    if (cache.has(organization.slug)) return cache.get(organization.slug);
    let resolved;
    if (config.provider === "fake") {
      resolved = process.env.NODE_ENV === "production" ? unconfiguredMarketingAdapter("fake provider is not allowed in production") : createFakeMarketingAdapter();
    } else {
      const { apiKey, source } = resolveBrandApiKey(organization.slug, { env, config });
      const quotaScope = quotaScopeFor(organization.slug, source);
      resolved = apiKey
        ? createResendMarketingAdapter({ apiKey, config, fetchImpl, quotaScope, quotaObserver: quotaObserver && quotaScope ? quotaObserver(quotaScope, "resend") : null })
        : unconfiguredMarketingAdapter(`No marketing provider key for brand ${organization.slug}`);
    }
    assertMarketingAdapter(resolved);
    cache.set(organization.slug, resolved);
    return resolved;
  };
}

// Non-secret description for status endpoints (never returns key material).
function describeBrandProvider(slug, { env = process.env, config }) {
  const { source } = resolveBrandApiKey(slug, { env, config });
  return { configured: source !== "none" || config.provider === "fake", credentialSource: config.provider === "fake" ? "fake" : source, credentialEnvName: brandKeyName(slug) };
}

module.exports = { createMarketingProviderResolver, resolveBrandApiKey, describeBrandProvider, brandKeyName, createFakeMarketingAdapter, quotaScopeFor };
