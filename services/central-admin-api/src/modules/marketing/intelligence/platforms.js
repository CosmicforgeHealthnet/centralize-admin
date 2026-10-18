const AD_PLATFORMS = Object.freeze(["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"]);

const PLATFORM_FILTERS = Object.freeze([
  "all",
  "meta",
  "tiktok",
  "x",
  "linkedin",
  "google_ads",
]);

function normalizePlatform(platform) {
  const normalized = String(platform || "").trim().toUpperCase();
  return AD_PLATFORMS.includes(normalized) ? normalized : null;
}

function normalizePlatformFilter(platform = "all") {
  const normalized = String(platform || "all").trim().toLowerCase();
  if (!PLATFORM_FILTERS.includes(normalized)) return null;
  return normalized === "all" ? "all" : normalized.toUpperCase();
}

module.exports = {
  AD_PLATFORMS,
  PLATFORM_FILTERS,
  normalizePlatform,
  normalizePlatformFilter,
};
