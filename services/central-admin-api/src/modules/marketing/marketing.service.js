const crypto = require("crypto");
const { Readable } = require("stream");
const cloudinary = require("../../shared/config/cloudinary");
const { prisma: adminPrisma } = require("../../shared/config/database");
const ApiError = require("../../shared/utils/ApiError");
const {
  assertLegacySocialReadAllowed,
  assertLegacySocialWriteAllowed,
  getLegacySocialCompatibilityPolicy,
} = require("./legacy-social-transition.policy");

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value, label) {
  if (!value || !UUID_REGEX.test(String(value))) {
    throw new ApiError(400, `Invalid ${label}.`);
  }

  return String(value);
}

function parseDate(value) {
  if (!value) return null;

  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function assertChronologicalDateRange(startDate, endDate, message = "endDate must not be before startDate") {
  if (!startDate || !endDate) return;

  if (new Date(endDate) < new Date(startDate)) {
    throw new ApiError(400, message);
  }
}

function formatDateDDMMYY(date) {
  if (!date) return null;

  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;

  const day = String(value.getUTCDate()).padStart(2, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const year = String(value.getUTCFullYear()).slice(-2);

  return `${day}/${month}/${year}`;
}

function formatDateYYYYMMDD(date) {
  if (!date) return null;

  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;

  return value.toISOString().slice(0, 10);
}

function safeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
}

function safeObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object" && !Array.isArray(value)) return value;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : fallback;
    } catch (error) {
      return fallback;
    }
  }

  return fallback;
}

function assertLegacySocialRead() {
  assertLegacySocialReadAllowed(getLegacySocialCompatibilityPolicy());
}

function assertLegacySocialWrite() {
  assertLegacySocialWriteAllowed(getLegacySocialCompatibilityPolicy());
}

function formatDateTimeYYYYMMDDHHMM(date) {
  if (!date) return null;

  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;

  const yyyyMMdd = formatDateYYYYMMDD(value);
  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");

  return `${yyyyMMdd} ${hours}:${minutes}`;
}

function trimNumber(value, decimals = 1) {
  const fixed = Number(value).toFixed(decimals);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function formatMetric(value) {
  const numberValue = safeNumber(value);

  if (numberValue <= 0) return "0";
  if (numberValue >= 1000000) return `${trimNumber(numberValue / 1000000)}M`;
  if (numberValue >= 1000) return `${trimNumber(numberValue / 1000)}K`;

  return String(Math.round(numberValue));
}

function formatWithCommas(value) {
  return Math.round(safeNumber(value)).toLocaleString("en-US");
}

function formatPercent(value) {
  const numberValue = safeNumber(value);
  if (numberValue <= 0) return "0%";

  return `${trimNumber(numberValue, 2)}%`;
}

function formatCurrency(value) {
  return `$${safeNumber(value).toFixed(2)}`;
}

function formatCurrencyAmount(value) {
  const numberValue = Math.round(safeNumber(value));
  return `$${numberValue.toLocaleString("en-US")}`;
}

function formatNumber(value) {
  return Math.round(safeNumber(value)).toLocaleString("en-US");
}

function getAuthorName(content) {
  return (
    content?.adminUser?.name ||
    content?.authorName ||
    content?.adminUser?.email ||
    "Unknown"
  );
}

function getTeamMemberName(member) {
  return member?.adminUser?.name || member?.adminUser?.email || "Unknown";
}

function buildCampaignWhere(query = {}) {
  const where = {};

  if (query.status) where.status = query.status;
  if (query.type) where.type = query.type;
  if (query.search) {
    where.title = {
      contains: query.search,
      mode: "insensitive",
    };
  }

  return where;
}

function buildContentWhere(query = {}) {
  const where = {};

  if (query.status) where.status = query.status;
  if (query.search) {
    where.title = {
      contains: query.search,
      mode: "insensitive",
    };
  }

  return where;
}

function mapCampaignListItem(campaign) {
  const performance = campaign.performance || {};

  return {
    id: campaign.id,
    title: campaign.title,
    type: campaign.type,
    status: campaign.status,
    date: formatDateDDMMYY(campaign.launchDate || campaign.createdAt),
    progress: safeNumber(campaign.progress),
    metrics: [
      { label: "Opens", value: formatMetric(performance.opens) },
      { label: "Clicks", value: formatMetric(performance.clicks) },
      { label: "Conversion", value: formatMetric(performance.conversions) },
    ],
  };
}

function mapCampaignDetail(campaign) {
  const performance = campaign.performance || {};

  return {
    id: campaign.id,
    title: campaign.title,
    type: campaign.type,
    status: campaign.status,
    budget: campaign.budget === null ? null : safeNumber(campaign.budget),
    progress: safeNumber(campaign.progress),
    startedAt: formatDateYYYYMMDD(campaign.launchDate),
    estCompletion: formatDateYYYYMMDD(campaign.estCompletion),
    targetAudience: campaign.targetAudience,
    duration: campaign.duration,
    channels: safeArray(campaign.channels),
    overview: campaign.overview,
    stats: {
      totalReach: formatWithCommas(performance.totalReach),
      engagementRate: formatPercent(performance.engagementRate),
      conversionRate: formatPercent(performance.conversionRate),
      costPerClick: formatCurrency(performance.costPerClick),
    },
  };
}

function mapCampaignMutation(campaign) {
  return {
    id: campaign.id,
    title: campaign.title,
    type: campaign.type,
    status: campaign.status,
    description: campaign.description,
    budget: campaign.budget === null ? null : safeNumber(campaign.budget),
    progress: safeNumber(campaign.progress),
    launchDate: formatDateYYYYMMDD(campaign.launchDate),
    estCompletion: formatDateYYYYMMDD(campaign.estCompletion),
    targetAudience: campaign.targetAudience,
    duration: campaign.duration,
    channels: safeArray(campaign.channels),
    overview: campaign.overview,
    createdAt: campaign.createdAt?.toISOString() || null,
    updatedAt: campaign.updatedAt?.toISOString() || null,
  };
}

function mapContentListItem(content) {
  return {
    id: content.id,
    title: content.title,
    type: content.type,
    author: getAuthorName(content),
    status: content.status,
    updatedAt: content.updatedAt?.toISOString() || null,
    performance: safeNumber(content.performance),
  };
}

function mapContentMutation(content) {
  return {
    id: content.id,
    title: content.title,
    type: content.type,
    authorId: content.authorId,
    author: getAuthorName(content),
    link: content.link,
    description: content.description,
    status: content.status,
    performance: safeNumber(content.performance),
    createdAt: content.createdAt?.toISOString() || null,
    updatedAt: content.updatedAt?.toISOString() || null,
  };
}

function csvValue(value) {
  if (value === null || value === undefined) return "";

  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function csvRow(values) {
  return values.map(csvValue).join(",");
}

function buildContentReportCsv(content) {
  const rows = [
    ["Field", "Value"],
    ["Content Title", content.title],
    ["Type", content.type],
    ["Author", getAuthorName(content)],
    ["Status", content.status],
    ["Performance", safeNumber(content.performance)],
    [],
    ["Month", "Value"],
    ...content.monthlyPerformance.map((item) => [item.month, safeNumber(item.value)]),
  ];

  return `${rows.map(csvRow).join("\r\n")}\r\n`;
}

function reportFilename(content) {
  const safeTitle = String(content.title || "content")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `marketing-content-${safeTitle || "report"}.csv`;
}

async function getCampaignOrThrow(id, include = {}) {
  const campaignId = assertUuid(id, "campaign id");
  const args = { where: { id: campaignId } };

  if (Object.keys(include).length > 0) args.include = include;

  const campaign = await adminPrisma.marketing_campaigns.findUnique(args);

  if (!campaign) throw new ApiError(404, "Campaign not found");
  return campaign;
}

async function getContentOrThrow(id, include = {}) {
  const contentId = assertUuid(id, "content id");
  const args = { where: { id: contentId } };

  if (Object.keys(include).length > 0) args.include = include;

  const content = await adminPrisma.marketing_content_items.findUnique(args);

  if (!content) throw new ApiError(404, "Content item not found");
  return content;
}

async function getAuthorOrThrow(authorId) {
  const id = assertUuid(authorId, "author id");
  const author = await adminPrisma.adminUser.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
    },
  });

  if (!author) throw new ApiError(404, "Author not found");
  return author;
}

function userDisplayName(user) {
  return user?.name || user?.email || "Unknown";
}

const EMAIL_CONTENT_DEFAULT = {
  greeting: "",
  vars: [],
  body: "",
  trackingVar: "",
};

const CONDITIONAL_BLOCK_DEFAULT = {
  condition: "",
  message: "",
};

const DEFAULT_RECIPIENTS = ["Customer", "Recipients"];
const SOCIAL_PLATFORMS = [
  "Facebook",
  "Instagram",
  "Youtube",
  "Twitter",
  "Tiktok",
  "LinkedIn",
];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKLY_DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function cloneDefault(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildChannelArray(emailEnabled, whatsappEnabled, smsEnabled) {
  const channels = [];

  if (emailEnabled) channels.push("Email");
  if (whatsappEnabled) channels.push("Whatsapp");
  if (smsEnabled) channels.push("SMS");

  return channels;
}

function parseDateTime(value) {
  return value ? new Date(value) : null;
}

function formatPlatformNumber(value, { plus = false, compact = false } = {}) {
  const numberValue = safeNumber(value);
  const sign = plus ? "+" : "";

  if (compact && Math.abs(numberValue) >= 1000) {
    return `${sign}${trimNumber(numberValue / 1000)}k`;
  }

  return `${sign}${Math.round(numberValue).toLocaleString("en-US")}`;
}

function normalizeContentBlock(value, fallback) {
  const block = safeObject(value, fallback);

  return {
    ...fallback,
    ...block,
    vars: safeArray(block.vars),
  };
}

function normalizeConditionalBlock(value) {
  return {
    ...CONDITIONAL_BLOCK_DEFAULT,
    ...safeObject(value, CONDITIONAL_BLOCK_DEFAULT),
  };
}

function getCredentialKey() {
  const rawKey = process.env.SOCIAL_CREDENTIAL_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new ApiError(400, "Social credential encryption is not configured.");
  }

  if (/^[a-f0-9]{64}$/i.test(rawKey)) {
    return Buffer.from(rawKey, "hex");
  }

  const base64 = Buffer.from(rawKey, "base64");
  if (base64.length === 32) return base64;

  return crypto.createHash("sha256").update(rawKey).digest();
}

function encryptSocialCredential(password) {
  const key = getCredentialKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptSocialCredentialIfNeeded(value) {
  if (!value) return null;

  const [version, ivText, tagText, encryptedText] = String(value).split(":");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) return null;

  const key = getCredentialKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivText, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function generateEventCode() {
  const events = await adminPrisma.marketing_notification_events.findMany({
    select: { eventCode: true },
  });
  const maxCode = events.reduce((max, item) => {
    const numberValue = Number(String(item.eventCode || "").replace(/\D/g, ""));
    return Number.isFinite(numberValue) ? Math.max(max, numberValue) : max;
  }, 1234);

  for (let next = maxCode + 1; next < maxCode + 1000; next += 1) {
    const eventCode = `#${next}`;
    const exists = await adminPrisma.marketing_notification_events.findUnique({
      where: { eventCode },
      select: { id: true },
    });

    if (!exists) return eventCode;
  }

  throw new ApiError(500, "Unable to generate event code");
}

function mapEmailTemplate(template) {
  return {
    id: template.id,
    validFrom: formatDateYYYYMMDD(template.validFrom),
    validTo: formatDateYYYYMMDD(template.validTo),
    language: template.language,
    status: template.status,
  };
}

function getLatestTemplate(event) {
  return Array.isArray(event.templates) && event.templates.length
    ? event.templates[0]
    : null;
}

function mapEmailTemplateListItem(event) {
  const latestTemplate = getLatestTemplate(event);
  const channels = buildChannelArray(
    event.emailEnabled,
    event.whatsappEnabled,
    event.smsEnabled,
  );

  return {
    id: event.id,
    eventCode: event.eventCode,
    event: event.event,
    customerChannels: channels,
    recipientChannels: channels,
    validToDate: formatDateYYYYMMDD(latestTemplate?.validTo || event.validToDate),
  };
}

function mapSocialPostListItem(post) {
  return {
    id: post.id,
    platform: post.platform,
    thumbnailUrl: post.thumbnailUrl || post.imageUrl || post.attachmentUrl,
    postedAt: (post.postedAt || post.scheduledFor || post.createdAt)?.toISOString() || null,
    excerpt: post.excerpt || post.caption || post.description || "",
    followers: formatPlatformNumber(post.followers, { plus: true, compact: true }),
    views: formatPlatformNumber(post.views),
    totalLikes: formatPlatformNumber(post.totalLikes),
    comments: formatPlatformNumber(post.comments, { plus: true }),
  };
}

function getPostImages(post) {
  const images = safeArray(post.attachmentUrls).filter(Boolean);
  if (post.attachmentUrl && !images.includes(post.attachmentUrl)) {
    images.unshift(post.attachmentUrl);
  }

  return images;
}

function safePerformance(post) {
  const performance = safeObject(post.performance, {});

  return {
    totalViews: safeNumber(performance.totalViews, safeNumber(post.views)),
    change: performance.change || "0%",
    likes: safeNumber(performance.likes, safeNumber(post.totalLikes)),
    reposts: safeNumber(performance.reposts),
    comments: safeNumber(performance.comments, safeNumber(post.comments)),
  };
}

function mapSocialPostDetail(post) {
  return {
    id: post.id,
    platform: post.platform,
    imageUrl: post.imageUrl || post.attachmentUrl,
    postedAt: (post.postedAt || post.scheduledFor || post.createdAt)?.toISOString() || null,
    description: post.description || post.caption || "",
    followers: formatPlatformNumber(post.followers, { plus: true, compact: true }),
    views: formatPlatformNumber(post.views),
    totalLikes: formatPlatformNumber(post.totalLikes),
    comments: formatPlatformNumber(post.comments, { plus: true }),
    locations: safeArray(post.locations),
    performance: safePerformance(post),
  };
}

function getExcerpt(text) {
  const value = String(text || "").trim();
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}

function getDateRangeFromQuery(query = {}) {
  if (!query.from && !query.to) return null;

  const range = {};
  if (query.from) range.gte = parseDateTime(query.from);
  if (query.to) range.lte = parseDateTime(query.to);

  return range;
}

function getScheduledRange(query = {}) {
  if (query.weekStart) {
    const start = parseDate(query.weekStart);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 7);

    return { gte: start, lt: end };
  }

  if (query.month) {
    const [year, month] = query.month.split("-").map(Number);
    return {
      gte: new Date(Date.UTC(year, month - 1, 1)),
      lt: new Date(Date.UTC(year, month, 1)),
    };
  }

  return null;
}

function buildWeeklyEngagement(posts) {
  const totals = Object.fromEntries(WEEKLY_DAY_ORDER.map((day) => [day, 0]));

  for (const post of posts) {
    const date = post.postedAt || post.scheduledFor || post.createdAt;
    if (!date) continue;

    const label = DAY_LABELS[new Date(date).getUTCDay()];
    totals[label] += safeNumber(post.totalLikes) + safeNumber(post.comments);
  }

  return WEEKLY_DAY_ORDER.map((day) => ({ day, value: totals[day] || 0 }));
}

function buildLocationOverview(posts) {
  const totals = new Map();

  for (const post of posts) {
    for (const location of safeArray(post.locations)) {
      if (!location?.country) continue;
      const current = totals.get(location.country) || 0;
      totals.set(location.country, current + safeNumber(location.value));
    }
  }

  return [...totals.entries()].map(([country, value]) => ({
    country,
    value,
    change: "0%",
    up: true,
  }));
}

function buildAudienceOverview(posts) {
  const byPlatform = new Map();

  for (const post of posts) {
    const current = byPlatform.get(post.platform) || 0;
    byPlatform.set(post.platform, current + safeNumber(post.followers));
  }

  const total = [...byPlatform.values()].reduce((sum, value) => sum + value, 0);

  return {
    total,
    change: "0%",
    breakdown: [...byPlatform.entries()].map(([platform, value]) => ({
      platform,
      value,
      change: "0%",
      up: true,
    })),
  };
}

function startOfUtcToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function computePromotionStatus(startDate, endDate) {
  const today = startOfUtcToday();
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (end < today) return "Completed";
  if (start > today) return "Upcoming";
  return "Active";
}

function computeBannerStatus(startDate, endDate) {
  const today = startOfUtcToday();
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (end < today) return "Expired";
  if (start > today) return "Inactive";
  return "Active";
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value === undefined || value === null || value === "") return [];

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (error) {
      return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    }

    return [trimmed];
  }

  return [];
}

function stringifyDisplay(value) {
  return parseJsonArray(value).join(", ");
}

function stringifyPlacement(value) {
  return parseJsonArray(value).join(", ");
}

function inferBannerMediaType(file = {}) {
  const name = String(file.originalname || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();
  const extension = name.split(".").pop();
  const map = {
    jpg: "Jpeg",
    jpeg: "Jpeg",
    png: "Png",
    webp: "Webp",
    gif: "Gif",
    pdf: "Pdf",
    doc: "Doc",
    docx: "Docx",
    xls: "Xls",
    xlsx: "Xlsx",
  };

  if (map[extension]) return map[extension];
  if (mime.includes("jpeg")) return "Jpeg";
  if (mime.includes("png")) return "Png";
  if (mime.includes("pdf")) return "Pdf";

  return extension ? extension.toUpperCase() : "File";
}

async function uploadBannerFile(file) {
  if (!file?.buffer) return null;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "marketing/banners",
        resource_type: "auto",
        use_filename: true,
        unique_filename: true,
      },
      (error, result) => {
        if (error) return reject(new ApiError(500, "Banner file upload failed"));
        return resolve(result);
      },
    );

    const readable = new Readable();
    readable.push(file.buffer);
    readable.push(null);
    readable.pipe(stream);
  });
}

async function deleteBannerCloudinaryFile(cloudinaryId) {
  if (!cloudinaryId) return;

  try {
    await cloudinary.uploader.destroy(cloudinaryId, { resource_type: "auto" });
  } catch (error) {
    // Best-effort cleanup only; DB delete/update should not fail on CDN cleanup.
  }
}

function mapPromotionListItem(promotion) {
  return {
    id: promotion.id,
    title: promotion.title,
    discountType: promotion.discountType,
    startDate: formatDateYYYYMMDD(promotion.startDate),
    endDate: formatDateYYYYMMDD(promotion.endDate),
    grossSales: formatNumber(promotion.grossSales),
    averageRate: formatPercent(promotion.averageRate),
    grossRevenue: formatCurrencyAmount(promotion.grossRevenue),
    status: promotion.status,
  };
}

function mapPromotionMutation(promotion) {
  return {
    id: promotion.id,
    title: promotion.title,
    discountType: promotion.discountType,
    startDate: formatDateYYYYMMDD(promotion.startDate),
    endDate: formatDateYYYYMMDD(promotion.endDate),
    grossSales: safeNumber(promotion.grossSales),
    averageRate: safeNumber(promotion.averageRate),
    grossRevenue: safeNumber(promotion.grossRevenue),
    status: promotion.status,
    createdAt: promotion.createdAt?.toISOString() || null,
    updatedAt: promotion.updatedAt?.toISOString() || null,
  };
}

function mapBannerListItem(banner) {
  return {
    id: banner.id,
    mediaType: banner.mediaType,
    title: banner.title,
    description: banner.description,
    display: stringifyDisplay(banner.display),
    externalLink: banner.externalLink,
    status: banner.status,
  };
}

function mapBannerDetail(banner) {
  return {
    id: banner.id,
    imageUrl: banner.imageUrl || banner.fileUrl,
    title: banner.title,
    description: banner.description,
    display: stringifyDisplay(banner.display),
    placement: stringifyPlacement(banner.placement),
    externalLink: banner.externalLink,
    startDate: formatDateYYYYMMDD(banner.startDate),
    endDate: formatDateYYYYMMDD(banner.endDate),
    status: banner.status,
    performance: {
      totalImpressions: formatNumber(banner.totalImpressions),
      change: formatPercent(banner.impressionsChange),
      clicks: formatNumber(banner.clicks),
      clicksChange: formatPercent(banner.clicksChange),
      signup: formatNumber(banner.signup),
      signupChange: formatPercent(banner.signupChange),
    },
  };
}

function mapBannerMutation(banner) {
  return {
    id: banner.id,
    mediaType: banner.mediaType,
    fileName: banner.fileName,
    fileUrl: banner.fileUrl,
    imageUrl: banner.imageUrl,
    title: banner.title,
    description: banner.description,
    display: safeArray(banner.display),
    placement: safeArray(banner.placement),
    externalLink: banner.externalLink,
    startDate: formatDateYYYYMMDD(banner.startDate),
    endDate: formatDateYYYYMMDD(banner.endDate),
    status: banner.status,
    createdAt: banner.createdAt?.toISOString() || null,
    updatedAt: banner.updatedAt?.toISOString() || null,
  };
}

function buildPromotionWhere(query = {}) {
  const where = {};

  if (query.search) {
    where.title = { contains: query.search, mode: "insensitive" };
  }

  if (query.tab === "Active Promotions") where.status = "Active";
  if (query.tab === "Upcoming Promotions") where.status = "Upcoming";
  if (query.tab === "Ended Promotions") where.status = { in: ["Completed", "Ended"] };

  return where;
}

function buildBannerWhere(query = {}) {
  const where = {};

  if (query.search) {
    where.title = { contains: query.search, mode: "insensitive" };
  }

  return where;
}

async function getPromotionOrThrow(id) {
  const promotionId = assertUuid(id, "promotion id");
  const promotion = await adminPrisma.marketing_promotions.findUnique({
    where: { id: promotionId },
  });

  if (!promotion) throw new ApiError(404, "Promotion not found");
  return promotion;
}

async function getBannerOrThrow(id) {
  const bannerId = assertUuid(id, "banner id");
  const banner = await adminPrisma.marketing_banners.findUnique({
    where: { id: bannerId },
  });

  if (!banner) throw new ApiError(404, "Banner not found");
  return banner;
}

async function getLatestMarketingAnalyticsSnapshot() {
  return adminPrisma.marketing_analytics_snapshots.findFirst({
    orderBy: [{ createdAt: "desc" }],
  });
}

function normalizeKpi(value, fallbackValue = 0) {
  const item = safeObject(value, {});

  return {
    value: item.value ?? fallbackValue,
    change: item.change || "0%",
    up: Boolean(item.up),
  };
}

function normalizeKpiToday(value, fallbackValue = 0) {
  const item = normalizeKpi(value, fallbackValue);

  return {
    ...item,
    today: safeNumber(safeObject(value, {}).today),
  };
}

function getThisWeekRange() {
  const today = startOfUtcToday();
  const day = today.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() + mondayOffset);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);

  return { start, end };
}

function isWithinRange(date, range) {
  if (!date) return false;
  const value = new Date(date);
  return value >= range.start && value < range.end;
}

// =======================
// Campaigns
// =======================

async function listCampaigns(query) {
  const where = buildCampaignWhere(query);
  const skip = (query.page - 1) * query.limit;

  const [campaigns, total, totalCount, active, drafts, completed] =
    await Promise.all([
      adminPrisma.marketing_campaigns.findMany({
        where,
        include: { performance: true },
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.limit,
      }),
      adminPrisma.marketing_campaigns.count({ where }),
      adminPrisma.marketing_campaigns.count(),
      adminPrisma.marketing_campaigns.count({ where: { status: "Active" } }),
      adminPrisma.marketing_campaigns.count({ where: { status: "Drafts" } }),
      adminPrisma.marketing_campaigns.count({ where: { status: "Completed" } }),
    ]);

  return {
    data: campaigns.map(mapCampaignListItem),
    stats: {
      total: totalCount,
      active,
      drafts,
      completed,
    },
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

async function getCampaign(id) {
  const campaign = await getCampaignOrThrow(id, { performance: true });
  return mapCampaignDetail(campaign);
}

async function getCampaignPerformance(id) {
  const campaign = await getCampaignOrThrow(id, { performance: true });
  const performance = campaign.performance || {};

  return {
    opens: formatMetric(performance.opens),
    clicks: formatMetric(performance.clicks),
    conversions: formatMetric(performance.conversions),
  };
}

async function getCampaignTimeline(id) {
  const campaignId = assertUuid(id, "campaign id");
  await getCampaignOrThrow(campaignId);

  const timeline = await adminPrisma.marketing_campaign_timeline.findMany({
    where: { campaignId },
    orderBy: [{ sortOrder: "asc" }, { date: "asc" }],
  });

  return {
    timeline: timeline.map((item) => ({
      label: item.label,
      date: formatDateDDMMYY(item.date),
      done: item.done,
    })),
  };
}

async function getCampaignTeam(id) {
  const campaignId = assertUuid(id, "campaign id");
  await getCampaignOrThrow(campaignId);

  const team = await adminPrisma.marketing_campaign_team_members.findMany({
    where: { campaignId },
    include: {
      adminUser: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
    orderBy: [{ createdAt: "asc" }],
  });

  return {
    team: team.map((member) => ({
      id: member.adminUserId || member.id,
      name: getTeamMemberName(member),
      role: member.role,
    })),
  };
}

async function createCampaign(data) {
  const campaign = await adminPrisma.marketing_campaigns.create({
    data: {
      title: data.title,
      type: data.type,
      description: data.description || null,
      launchDate: parseDate(data.launchDate),
      status: "Drafts",
      progress: 0,
    },
    select: {
      id: true,
      title: true,
      status: true,
    },
  });

  return campaign;
}

async function updateCampaign(id, data) {
  const campaignId = assertUuid(id, "campaign id");
  await getCampaignOrThrow(campaignId);

  const updateData = {};
  const fields = [
    "title",
    "type",
    "description",
    "budget",
    "targetAudience",
    "duration",
    "channels",
    "overview",
  ];

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      updateData[field] = data[field];
    }
  }

  if (data.launchDate) updateData.launchDate = parseDate(data.launchDate);
  if (data.estCompletion) updateData.estCompletion = parseDate(data.estCompletion);

  const updated = await adminPrisma.marketing_campaigns.update({
    where: { id: campaignId },
    data: updateData,
  });

  return mapCampaignMutation(updated);
}

async function deleteCampaign(id) {
  const campaignId = assertUuid(id, "campaign id");
  await getCampaignOrThrow(campaignId);

  await adminPrisma.$transaction([
    adminPrisma.marketing_campaign_performance.deleteMany({
      where: { campaignId },
    }),
    adminPrisma.marketing_campaign_timeline.deleteMany({
      where: { campaignId },
    }),
    adminPrisma.marketing_campaign_team_members.deleteMany({
      where: { campaignId },
    }),
    adminPrisma.marketing_campaigns.delete({
      where: { id: campaignId },
    }),
  ]);
}

async function updateCampaignStatus(id, data) {
  const campaignId = assertUuid(id, "campaign id");
  await getCampaignOrThrow(campaignId);

  const updated = await adminPrisma.marketing_campaigns.update({
    where: { id: campaignId },
    data: { status: data.status },
    select: { status: true },
  });

  return updated;
}

async function duplicateCampaign(id) {
  const source = await getCampaignOrThrow(id);

  const duplicate = await adminPrisma.marketing_campaigns.create({
    data: {
      title: `${source.title} (Copy)`,
      type: source.type,
      status: "Drafts",
      description: source.description,
      budget: source.budget,
      progress: 0,
      launchDate: source.launchDate,
      estCompletion: source.estCompletion,
      targetAudience: source.targetAudience,
      duration: source.duration,
      channels: safeArray(source.channels),
      overview: source.overview,
    },
    select: {
      id: true,
      title: true,
    },
  });

  return duplicate;
}

// =======================
// Content Manager
// =======================

async function listContent(query) {
  const where = buildContentWhere(query);
  const skip = (query.page - 1) * query.limit;

  const [items, total, sent, draft] = await Promise.all([
    adminPrisma.marketing_content_items.findMany({
      where,
      include: {
        adminUser: {
          select: {
            name: true,
            email: true,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }],
      skip,
      take: query.limit,
    }),
    adminPrisma.marketing_content_items.count({ where }),
    adminPrisma.marketing_content_items.count({ where: { status: "Published" } }),
    adminPrisma.marketing_content_items.count({ where: { status: "Draft" } }),
  ]);

  return {
    data: items.map(mapContentListItem),
    counts: {
      sent,
      draft,
    },
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

async function getContent(id) {
  const content = await getContentOrThrow(id, {
    adminUser: {
      select: {
        name: true,
        email: true,
      },
    },
  });

  return {
    id: content.id,
    title: content.title,
    type: content.type,
    author: getAuthorName(content),
    link: content.link,
    description: content.description,
    status: content.status,
  };
}

async function getContentPerformance(id) {
  const contentId = assertUuid(id, "content id");
  await getContentOrThrow(contentId);

  const chartData = await adminPrisma.marketing_content_monthly_performance.findMany({
    where: { contentId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      month: true,
      value: true,
    },
  });

  return { chartData };
}

async function createContent(data) {
  const author = await getAuthorOrThrow(data.authorId);

  const content = await adminPrisma.marketing_content_items.create({
    data: {
      title: data.title,
      type: data.type,
      authorId: author.id,
      authorName: userDisplayName(author),
      link: data.link || null,
      description: data.description || null,
      status: "Draft",
      performance: 0,
    },
    select: {
      id: true,
      title: true,
      status: true,
    },
  });

  return content;
}

async function updateContent(id, data) {
  const contentId = assertUuid(id, "content id");
  await getContentOrThrow(contentId);

  const updateData = {};
  const fields = [
    "title",
    "type",
    "link",
    "description",
    "status",
    "performance",
  ];

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      updateData[field] = data[field];
    }
  }

  if (data.authorId) {
    const author = await getAuthorOrThrow(data.authorId);
    updateData.authorId = author.id;
    updateData.authorName = userDisplayName(author);
  }

  const updated = await adminPrisma.marketing_content_items.update({
    where: { id: contentId },
    data: updateData,
    include: {
      adminUser: {
        select: {
          name: true,
          email: true,
        },
      },
    },
  });

  return mapContentMutation(updated);
}

async function deleteContent(id) {
  const contentId = assertUuid(id, "content id");
  await getContentOrThrow(contentId);

  await adminPrisma.$transaction([
    adminPrisma.marketing_content_monthly_performance.deleteMany({
      where: { contentId },
    }),
    adminPrisma.marketing_content_items.delete({
      where: { id: contentId },
    }),
  ]);
}

async function getContentReport(id, query) {
  const content = await getContentOrThrow(id, {
    adminUser: {
      select: {
        name: true,
        email: true,
      },
    },
    monthlyPerformance: {
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    },
  });

  if (query.format === "pdf") {
    throw new ApiError(400, "PDF export is not configured yet.");
  }

  return {
    format: "csv",
    filename: reportFilename(content),
    csv: buildContentReportCsv(content),
  };
}

// =======================
// Email Templates
// =======================

async function getEmailTemplateEventOrThrow(id, include = {}) {
  const eventId = assertUuid(id, "email template event id");
  const args = { where: { id: eventId } };

  if (Object.keys(include).length > 0) args.include = include;

  const event = await adminPrisma.marketing_notification_events.findUnique(args);
  if (!event) throw new ApiError(404, "Event not found");

  return event;
}

async function listEmailTemplates(query) {
  const where = {};

  if (query.search) {
    where.event = {
      contains: query.search,
      mode: "insensitive",
    };
  }

  const skip = (query.page - 1) * query.limit;
  const [events, total] = await Promise.all([
    adminPrisma.marketing_notification_events.findMany({
      where,
      include: {
        templates: {
          orderBy: [{ validTo: "desc" }, { createdAt: "desc" }],
          take: 1,
        },
      },
      orderBy: [{ createdAt: "desc" }],
      skip,
      take: query.limit,
    }),
    adminPrisma.marketing_notification_events.count({ where }),
  ]);

  return {
    data: events.map(mapEmailTemplateListItem),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

async function getEmailTemplate(id) {
  const event = await getEmailTemplateEventOrThrow(id, {
    templates: {
      orderBy: [{ validTo: "desc" }, { createdAt: "desc" }],
    },
  });

  return {
    id: event.id,
    eventCode: event.eventCode,
    notifyEnabled: event.notifyEnabled,
    channels: {
      email: Boolean(event.emailEnabled),
      whatsapp: Boolean(event.whatsappEnabled),
      sms: Boolean(event.smsEnabled),
    },
    recipients: safeArray(event.recipients),
    templates: event.templates.map(mapEmailTemplate),
    customer: {
      fullName: event.customerFullName || "",
      email: event.customerEmail || "",
      phone: event.customerPhone || "",
      country: event.customerCountry || "",
    },
    emailContent: normalizeContentBlock(
      event.emailContent,
      cloneDefault(EMAIL_CONTENT_DEFAULT),
    ),
    conditionalBlock: normalizeConditionalBlock(event.conditionalBlock),
    whatsappContent: normalizeContentBlock(
      event.whatsappContent,
      cloneDefault(EMAIL_CONTENT_DEFAULT),
    ),
  };
}

async function createEmailTemplate(data) {
  const eventCode = await generateEventCode();
  const validFrom = parseDate(data.validFrom);
  const validTo = parseDate(data.validTo);
  assertChronologicalDateRange(validFrom, validTo, "validTo must not be before validFrom");

  const event = await adminPrisma.$transaction(async (tx) => {
    const createdEvent = await tx.marketing_notification_events.create({
      data: {
        eventCode,
        event: data.event,
        notifyEnabled: true,
        emailEnabled: true,
        whatsappEnabled: true,
        smsEnabled: true,
        recipients: DEFAULT_RECIPIENTS,
        validToDate: validTo,
      },
      select: {
        id: true,
        eventCode: true,
      },
    });

    await tx.marketing_email_templates.create({
      data: {
        eventId: createdEvent.id,
        validFrom,
        validTo,
        language: data.language,
      },
    });

    return createdEvent;
  });

  return event;
}

async function updateEmailTemplate(id, data) {
  const eventId = assertUuid(id, "email template event id");
  await getEmailTemplateEventOrThrow(eventId);

  const latestTemplate = await adminPrisma.marketing_email_templates.findFirst({
    where: { eventId },
    orderBy: [{ validTo: "desc" }, { createdAt: "desc" }],
  });

  const updateData = {};
  if (data.validFrom) updateData.validFrom = parseDate(data.validFrom);
  if (data.validTo) updateData.validTo = parseDate(data.validTo);
  if (data.language) updateData.language = data.language;

  const nextValidFrom = Object.prototype.hasOwnProperty.call(updateData, "validFrom")
    ? updateData.validFrom
    : latestTemplate?.validFrom;
  const nextValidTo = Object.prototype.hasOwnProperty.call(updateData, "validTo")
    ? updateData.validTo
    : latestTemplate?.validTo;
  assertChronologicalDateRange(nextValidFrom, nextValidTo, "validTo must not be before validFrom");

  const updatedTemplate = latestTemplate
    ? await adminPrisma.marketing_email_templates.update({
        where: { id: latestTemplate.id },
        data: updateData,
      })
    : await adminPrisma.marketing_email_templates.create({
        data: {
          eventId,
          validFrom: updateData.validFrom || new Date(),
          validTo: updateData.validTo || updateData.validFrom || new Date(),
          language: updateData.language || "EN",
        },
      });

  if (data.validTo) {
    await adminPrisma.marketing_notification_events.update({
      where: { id: eventId },
      data: { validToDate: parseDate(data.validTo) },
    });
  }

  return mapEmailTemplate(updatedTemplate);
}

async function deleteEmailTemplate(id) {
  const eventId = assertUuid(id, "email template event id");
  await getEmailTemplateEventOrThrow(eventId);

  await adminPrisma.$transaction([
    adminPrisma.marketing_email_templates.deleteMany({ where: { eventId } }),
    adminPrisma.marketing_notification_events.delete({ where: { id: eventId } }),
  ]);
}

async function updateEmailTemplateNotification(id, data) {
  const eventId = assertUuid(id, "email template event id");
  await getEmailTemplateEventOrThrow(eventId);

  return adminPrisma.marketing_notification_events.update({
    where: { id: eventId },
    data: { notifyEnabled: data.notifyEnabled },
    select: { notifyEnabled: true },
  });
}

async function updateEmailTemplateRecipients(id, data) {
  const eventId = assertUuid(id, "email template event id");
  await getEmailTemplateEventOrThrow(eventId);

  await adminPrisma.marketing_notification_events.update({
    where: { id: eventId },
    data: {
      emailEnabled: data.channels.email,
      whatsappEnabled: data.channels.whatsapp,
      smsEnabled: data.channels.sms,
      recipients: data.recipients,
    },
  });
}

async function updateEmailTemplateContent(id, data) {
  const eventId = assertUuid(id, "email template event id");
  await getEmailTemplateEventOrThrow(eventId);

  const updateData = {};
  if (data.emailContent) updateData.emailContent = data.emailContent;
  if (data.conditionalBlock) updateData.conditionalBlock = data.conditionalBlock;
  if (data.whatsappContent) updateData.whatsappContent = data.whatsappContent;

  await adminPrisma.marketing_notification_events.update({
    where: { id: eventId },
    data: updateData,
  });
}

async function searchEmailTemplateCustomers(query) {
  void query;
  return { data: [] };
}

// =======================
// Social Media
// =======================

async function getSocialOverview() {
  const [snapshot, posts, recentUpload] = await Promise.all([
    adminPrisma.marketing_social_analytics_snapshots.findFirst({
      orderBy: [{ createdAt: "desc" }],
    }),
    adminPrisma.marketing_social_posts.findMany({
      where: { status: { not: "Deleted" } },
    }),
    adminPrisma.marketing_social_posts.findFirst({
      where: { status: "Published" },
      orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  const stats = safeObject(snapshot?.stats, {
    userEngagement: posts.reduce(
      (sum, post) => sum + safeNumber(post.totalLikes) + safeNumber(post.comments),
      0,
    ),
    trafficSources: posts.reduce((sum, post) => sum + safeNumber(post.views), 0),
    audienceGrowth: posts.reduce((sum, post) => sum + safeNumber(post.followers), 0),
    contentPerformance: posts.reduce(
      (sum, post) => sum + safeNumber(post.views) + safeNumber(post.totalLikes),
      0,
    ),
  });

  return {
    stats: {
      userEngagement: safeNumber(stats.userEngagement),
      trafficSources: safeNumber(stats.trafficSources),
      audienceGrowth: safeNumber(stats.audienceGrowth),
      contentPerformance: safeNumber(stats.contentPerformance),
    },
    locations: safeArray(snapshot?.locations).length
      ? safeArray(snapshot.locations)
      : buildLocationOverview(posts),
    audience: Object.keys(safeObject(snapshot?.audience, {})).length
      ? safeObject(snapshot.audience)
      : buildAudienceOverview(posts),
    recentUpload: recentUpload
      ? {
          id: recentUpload.id,
          title: recentUpload.caption,
          excerpt: getExcerpt(recentUpload.excerpt || recentUpload.description || recentUpload.caption),
          likesCount: safeNumber(recentUpload.totalLikes),
        }
      : safeObject(snapshot?.recentUpload, {
          id: null,
          title: "",
          excerpt: "",
          likesCount: 0,
        }),
    weeklyEngagement: safeArray(snapshot?.weeklyEngagement).length
      ? safeArray(snapshot.weeklyEngagement)
      : buildWeeklyEngagement(posts),
    totalEngagementChange: snapshot?.totalEngagementChange || "+0",
  };
}

async function listSocialAccounts() {
  assertLegacySocialRead();
  const accounts = await adminPrisma.marketing_social_accounts.findMany({
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      platform: true,
      username: true,
      connected: true,
    },
  });

  return { data: accounts };
}

async function createSocialAccount(data) {
  assertLegacySocialWrite();
  // Legacy username/password provider credentials are no longer persisted.
  // Social Operations connections require a fresh OAuth authorization.
  const encryptedPassword = null;

  const existing = await adminPrisma.marketing_social_accounts.findFirst({
    where: {
      platform: data.platform,
      username: data.username,
    },
    select: { id: true },
  });

  const account = existing
    ? await adminPrisma.marketing_social_accounts.update({
        where: { id: existing.id },
        data: {
          connected: true,
          encryptedPassword,
          credentialsSaved: false,
        },
        select: { id: true, platform: true },
      })
    : await adminPrisma.marketing_social_accounts.create({
        data: {
          platform: data.platform,
          username: data.username,
          connected: true,
          encryptedPassword,
          credentialsSaved: false,
        },
        select: { id: true, platform: true },
      });

  return account;
}

async function deleteSocialAccount(id) {
  assertLegacySocialWrite();
  const accountId = assertUuid(id, "social account id");
  const account = await adminPrisma.marketing_social_accounts.findUnique({
    where: { id: accountId },
    select: { id: true },
  });

  if (!account) throw new ApiError(404, "Social account not found");

  await adminPrisma.marketing_social_accounts.delete({ where: { id: accountId } });
}

async function listSocialPosts(query) {
  assertLegacySocialRead();
  const where = { status: { not: "Deleted" } };
  if (query.platform && query.platform !== "All") where.platform = query.platform;

  const posts = await adminPrisma.marketing_social_posts.findMany({
    where,
    orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
    skip: (query.page - 1) * query.limit,
    take: query.limit,
  });

  return { data: posts.map(mapSocialPostListItem) };
}

async function createSocialPost(data) {
  assertLegacySocialWrite();
  const post = await adminPrisma.marketing_social_posts.create({
    data: {
      platform: data.platform,
      caption: data.caption,
      description: data.caption,
      excerpt: getExcerpt(data.caption),
      attachmentUrl: data.attachmentUrl || null,
      attachmentUrls: data.attachmentUrl ? [data.attachmentUrl] : [],
      thumbnailUrl: data.attachmentUrl || null,
      imageUrl: data.attachmentUrl || null,
      postedAt: null,
      status: "Draft",
    },
    select: {
      id: true,
      platform: true,
    },
  });

  return post;
}

async function getSocialPost(id) {
  assertLegacySocialRead();
  const postId = assertUuid(id, "social post id");
  const post = await adminPrisma.marketing_social_posts.findFirst({
    where: {
      id: postId,
      status: { not: "Deleted" },
    },
  });

  if (!post) throw new ApiError(404, "Social post not found");

  return mapSocialPostDetail(post);
}

async function updateSocialPost(id, data) {
  assertLegacySocialWrite();
  const postId = assertUuid(id, "social post id");
  const post = await adminPrisma.marketing_social_posts.findUnique({
    where: { id: postId },
    select: { id: true, status: true },
  });

  if (!post || post.status === "Deleted") {
    throw new ApiError(404, "Social post not found");
  }

  if (post.status === "Published") {
    throw new ApiError(400, "Only unpublished or scheduled posts can be edited");
  }

  const updateData = {};
  if (data.caption) {
    updateData.caption = data.caption;
    updateData.description = data.caption;
    updateData.excerpt = getExcerpt(data.caption);
  }
  if (data.attachmentUrl !== undefined) {
    updateData.attachmentUrl = data.attachmentUrl || null;
    updateData.thumbnailUrl = data.attachmentUrl || null;
    updateData.imageUrl = data.attachmentUrl || null;
  }
  if (data.attachmentUrls) {
    updateData.attachmentUrls = data.attachmentUrls;
    updateData.attachmentUrl = data.attachmentUrls[0] || null;
    updateData.thumbnailUrl = data.attachmentUrls[0] || null;
    updateData.imageUrl = data.attachmentUrls[0] || null;
  }

  await adminPrisma.marketing_social_posts.update({
    where: { id: postId },
    data: updateData,
  });
}

async function deleteSocialPost(id) {
  assertLegacySocialWrite();
  const postId = assertUuid(id, "social post id");
  const post = await adminPrisma.marketing_social_posts.findUnique({
    where: { id: postId },
    select: { id: true },
  });

  if (!post) throw new ApiError(404, "Social post not found");

  await adminPrisma.marketing_social_posts.update({
    where: { id: postId },
    data: { status: "Deleted" },
  });
}

async function getSocialSchedule(query) {
  assertLegacySocialRead();
  const scheduledFor = getScheduledRange(query);
  const where = {
    status: "Scheduled",
    scheduledFor: scheduledFor || { not: null },
  };

  const posts = await adminPrisma.marketing_social_posts.findMany({
    where,
    orderBy: [{ scheduledFor: "asc" }],
  });

  const dayMap = new Map();
  const slotMap = new Map();

  for (const post of posts) {
    if (!post.scheduledFor) continue;

    const scheduled = new Date(post.scheduledFor);
    const dayKey = formatDateYYYYMMDD(scheduled);
    if (!dayMap.has(dayKey)) {
      dayMap.set(dayKey, {
        day: DAY_LABELS[scheduled.getUTCDay()],
        date: scheduled.getUTCDate(),
      });
    }

    const time = `${String(scheduled.getUTCHours()).padStart(2, "0")}:${String(
      scheduled.getUTCMinutes(),
    ).padStart(2, "0")}`;
    const images = getPostImages(post);
    if (!slotMap.has(time)) slotMap.set(time, []);
    slotMap.get(time).push({
      platform: post.platform,
      text: post.caption,
      images: images.slice(0, 2),
      extra: Math.max(0, images.length - 2),
    });
  }

  return {
    days: [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value),
    slots: [...slotMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([time, slotPosts]) => ({ time, posts: slotPosts })),
  };
}

async function createSocialSchedule(data) {
  assertLegacySocialWrite();
  const scheduledFor = parseDateTime(data.scheduledFor);
  const post = await adminPrisma.marketing_social_posts.create({
    data: {
      platform: data.platform,
      caption: data.caption,
      description: data.caption,
      excerpt: getExcerpt(data.caption),
      attachmentUrl: data.attachmentUrls[0] || null,
      attachmentUrls: data.attachmentUrls,
      thumbnailUrl: data.attachmentUrls[0] || null,
      imageUrl: data.attachmentUrls[0] || null,
      scheduledFor,
      status: "Draft",
    },
    select: { id: true },
  });

  return post;
}

async function getSocialInsights(query) {
  const range = getDateRangeFromQuery(query);
  const where = { status: { not: "Deleted" } };

  if (range) {
    where.OR = [{ postedAt: range }, { scheduledFor: range }];
  }

  const posts = await adminPrisma.marketing_social_posts.findMany({ where });
  const byPlatform = new Map();

  for (const post of posts) {
    if (!byPlatform.has(post.platform)) {
      byPlatform.set(post.platform, {
        platform: post.platform,
        posts: 0,
        audience: 0,
        totalLikes: 0,
        followers: 0,
      });
    }

    const row = byPlatform.get(post.platform);
    row.posts += 1;
    row.audience += safeNumber(post.views);
    row.totalLikes += safeNumber(post.totalLikes);
    row.followers += safeNumber(post.followers);
  }

  return {
    data: SOCIAL_PLATFORMS.filter((platform) => byPlatform.has(platform)).map(
      (platform) => {
        const row = byPlatform.get(platform);
        return {
          platform,
          posts: row.posts,
          audience: formatPlatformNumber(row.audience),
          totalLikes: formatPlatformNumber(row.totalLikes),
          followers: formatPlatformNumber(row.followers, { plus: true }),
        };
      },
    ),
  };
}
// =======================
// Banners & Promotion
// =======================

async function listPromotions(query) {
  const where = buildPromotionWhere(query);
  const skip = (query.page - 1) * query.limit;

  const [promotions, total, totalPromotions, revenueAggregate, rateAggregate] =
    await Promise.all([
      adminPrisma.marketing_promotions.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.limit,
      }),
      adminPrisma.marketing_promotions.count({ where }),
      adminPrisma.marketing_promotions.count(),
      adminPrisma.marketing_promotions.aggregate({ _sum: { grossRevenue: true } }),
      adminPrisma.marketing_promotions.aggregate({ _avg: { averageRate: true } }),
    ]);

  return {
    data: promotions.map(mapPromotionListItem),
    stats: {
      totalPromotions,
      engagementRate: formatPercent(rateAggregate._avg.averageRate),
      revenue: formatCurrencyAmount(revenueAggregate._sum.grossRevenue),
    },
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

async function createPromotion(data) {
  const startDate = parseDate(data.startDate);
  const endDate = parseDate(data.endDate);
  assertChronologicalDateRange(startDate, endDate);
  const promotion = await adminPrisma.marketing_promotions.create({
    data: {
      title: data.title,
      discountType: data.discountType,
      startDate,
      endDate,
      status: computePromotionStatus(startDate, endDate),
    },
    select: {
      id: true,
      status: true,
    },
  });

  return promotion;
}

async function updatePromotion(id, data) {
  const existing = await getPromotionOrThrow(id);
  const updateData = {};

  for (const field of [
    "title",
    "discountType",
    "grossSales",
    "averageRate",
    "grossRevenue",
    "status",
  ]) {
    if (Object.prototype.hasOwnProperty.call(data, field)) updateData[field] = data[field];
  }

  const startDate = data.startDate ? parseDate(data.startDate) : existing.startDate;
  const endDate = data.endDate ? parseDate(data.endDate) : existing.endDate;
  assertChronologicalDateRange(startDate, endDate);

  if (data.startDate) updateData.startDate = startDate;
  if (data.endDate) updateData.endDate = endDate;
  if (!data.status && (data.startDate || data.endDate)) {
    updateData.status = computePromotionStatus(startDate, endDate);
  }

  const promotion = await adminPrisma.marketing_promotions.update({
    where: { id: existing.id },
    data: updateData,
  });

  return mapPromotionMutation(promotion);
}

async function deletePromotion(id) {
  const promotion = await getPromotionOrThrow(id);
  await adminPrisma.marketing_promotions.delete({ where: { id: promotion.id } });
}

async function listBanners(query) {
  const where = buildBannerWhere(query);
  const skip = (query.page - 1) * query.limit;

  const [banners, total] = await Promise.all([
    adminPrisma.marketing_banners.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip,
      take: query.limit,
    }),
    adminPrisma.marketing_banners.count({ where }),
  ]);

  return {
    data: banners.map(mapBannerListItem),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

async function getBanner(id) {
  const banner = await getBannerOrThrow(id);
  return mapBannerDetail(banner);
}

async function createBanner(data, file) {
  if (!file) throw new ApiError(400, "Banner file is required");

  const startDate = parseDate(data.startDate);
  const endDate = parseDate(data.endDate);
  assertChronologicalDateRange(startDate, endDate);
  const uploaded = await uploadBannerFile(file);
  const fileUrl = uploaded?.secure_url || null;
  const banner = await adminPrisma.marketing_banners.create({
    data: {
      mediaType: inferBannerMediaType(file),
      fileName: file.originalname || null,
      fileUrl,
      imageUrl: fileUrl,
      cloudinaryId: uploaded?.public_id || null,
      title: data.title,
      description: data.description,
      display: parseJsonArray(data.display),
      placement: parseJsonArray(data.placement),
      externalLink: data.externalLink,
      startDate,
      endDate,
      status: computeBannerStatus(startDate, endDate),
    },
    select: {
      id: true,
      status: true,
    },
  });

  return banner;
}

async function updateBanner(id, data, file) {
  const existing = await getBannerOrThrow(id);
  const hasBody = Object.keys(data || {}).length > 0;
  if (!hasBody && !file) {
    throw new ApiError(400, "At least one valid field or file must be provided");
  }

  const updateData = {};
  for (const field of [
    "title",
    "description",
    "externalLink",
    "totalImpressions",
    "impressionsChange",
    "clicks",
    "clicksChange",
    "signup",
    "signupChange",
  ]) {
    if (Object.prototype.hasOwnProperty.call(data, field)) updateData[field] = data[field];
  }

  if (Object.prototype.hasOwnProperty.call(data, "display")) {
    updateData.display = parseJsonArray(data.display);
  }
  if (Object.prototype.hasOwnProperty.call(data, "placement")) {
    updateData.placement = parseJsonArray(data.placement);
  }

  const startDate = data.startDate ? parseDate(data.startDate) : existing.startDate;
  const endDate = data.endDate ? parseDate(data.endDate) : existing.endDate;
  assertChronologicalDateRange(startDate, endDate);
  if (data.startDate) updateData.startDate = startDate;
  if (data.endDate) updateData.endDate = endDate;
  if (data.startDate || data.endDate) updateData.status = computeBannerStatus(startDate, endDate);

  if (file) {
    const uploaded = await uploadBannerFile(file);
    await deleteBannerCloudinaryFile(existing.cloudinaryId);
    updateData.mediaType = inferBannerMediaType(file);
    updateData.fileName = file.originalname || null;
    updateData.fileUrl = uploaded?.secure_url || null;
    updateData.imageUrl = uploaded?.secure_url || null;
    updateData.cloudinaryId = uploaded?.public_id || null;
  }

  const banner = await adminPrisma.marketing_banners.update({
    where: { id: existing.id },
    data: updateData,
  });

  return mapBannerMutation(banner);
}

async function deleteBanner(id) {
  const banner = await getBannerOrThrow(id);
  await adminPrisma.marketing_banners.delete({ where: { id: banner.id } });
  await deleteBannerCloudinaryFile(banner.cloudinaryId);
}

async function updateBannerStatus(id, data) {
  const banner = await getBannerOrThrow(id);
  return adminPrisma.marketing_banners.update({
    where: { id: banner.id },
    data: { status: data.status },
    select: { status: true },
  });
}

// =======================
// Analytics
// =======================

async function getAnalyticsOverviewStats() {
  const snapshot = await getLatestMarketingAnalyticsSnapshot();
  const saved = safeObject(snapshot?.overviewStats, null);
  if (saved) {
    return {
      leadsCapture: normalizeKpi(saved.leadsCapture),
      campaignRoi: normalizeKpi(saved.campaignRoi, "0%"),
      clickThroughRate: normalizeKpi(saved.clickThroughRate, "0%"),
      costPerClick: normalizeKpi(saved.costPerClick, "$0"),
      impressions: normalizeKpi(saved.impressions, "0"),
    };
  }

  const [performanceRows, banners, campaigns] = await Promise.all([
    adminPrisma.marketing_campaign_performance.findMany(),
    adminPrisma.marketing_banners.findMany(),
    adminPrisma.marketing_campaigns.findMany(),
  ]);
  const leads =
    performanceRows.reduce((sum, row) => sum + safeNumber(row.conversions), 0) +
    banners.reduce((sum, banner) => sum + safeNumber(banner.signup), 0);
  const clicks =
    performanceRows.reduce((sum, row) => sum + safeNumber(row.clicks), 0) +
    banners.reduce((sum, banner) => sum + safeNumber(banner.clicks), 0);
  const impressions = banners.reduce(
    (sum, banner) => sum + safeNumber(banner.totalImpressions),
    0,
  );
  const budget = campaigns.reduce((sum, campaign) => sum + safeNumber(campaign.budget), 0);
  const cpcRows = performanceRows.map((row) => safeNumber(row.costPerClick)).filter(Boolean);
  const cpc = cpcRows.length
    ? cpcRows.reduce((sum, value) => sum + value, 0) / cpcRows.length
    : 0;

  return {
    leadsCapture: { value: leads, change: "0%", up: true },
    campaignRoi: { value: budget > 0 ? `${Math.round((leads / budget) * 100)}%` : "0%", change: "0%", up: false },
    clickThroughRate: { value: impressions > 0 ? formatPercent((clicks / impressions) * 100) : "0%", change: "0%", up: true },
    costPerClick: { value: formatCurrency(cpc), change: "0%", up: false },
    impressions: { value: formatMetric(impressions), change: "0%", up: true },
  };
}

async function getAnalyticsSocialStats() {
  const snapshot = await getLatestMarketingAnalyticsSnapshot();
  const saved = safeObject(snapshot?.socialStats, null);
  if (saved) {
    return {
      userEngagement: normalizeKpiToday(saved.userEngagement),
      trafficSources: normalizeKpiToday(saved.trafficSources),
      audienceGrowth: normalizeKpiToday(saved.audienceGrowth),
      contentPerformance: normalizeKpiToday(saved.contentPerformance),
    };
  }

  const posts = await adminPrisma.marketing_social_posts.findMany({
    where: { status: { not: "Deleted" } },
  });
  const today = startOfUtcToday();
  const todayPosts = posts.filter((post) => new Date(post.createdAt) >= today);
  const engagement = posts.reduce(
    (sum, post) => sum + safeNumber(post.totalLikes) + safeNumber(post.comments),
    0,
  );
  const traffic = posts.reduce((sum, post) => sum + safeNumber(post.views), 0);
  const audience = posts.reduce((sum, post) => sum + safeNumber(post.followers), 0);
  const contentPerformance = traffic + engagement;
  const todayEngagement = todayPosts.reduce(
    (sum, post) => sum + safeNumber(post.totalLikes) + safeNumber(post.comments),
    0,
  );

  return {
    userEngagement: { value: engagement, change: "0%", up: true, today: todayEngagement },
    trafficSources: { value: traffic, change: "0%", up: true, today: todayPosts.reduce((sum, post) => sum + safeNumber(post.views), 0) },
    audienceGrowth: { value: audience, change: "0%", up: false, today: todayPosts.reduce((sum, post) => sum + safeNumber(post.followers), 0) },
    contentPerformance: { value: contentPerformance, change: "0%", up: true, today: todayEngagement + todayPosts.reduce((sum, post) => sum + safeNumber(post.views), 0) },
  };
}

async function getAnalyticsAdsPerformance() {
  const snapshot = await getLatestMarketingAnalyticsSnapshot();
  const saved = safeObject(snapshot?.adsPerformance, null);
  if (saved) {
    return {
      byPlatform: safeArray(saved.byPlatform),
      monthlyTrend: safeArray(saved.monthlyTrend),
    };
  }

  return { byPlatform: [], monthlyTrend: [] };
}

async function getAnalyticsLocation() {
  const snapshot = await getLatestMarketingAnalyticsSnapshot();
  const saved = safeArray(snapshot?.locations);
  if (saved.length) return { data: saved };

  const posts = await adminPrisma.marketing_social_posts.findMany({
    where: { status: { not: "Deleted" } },
    select: { locations: true },
  });
  const totals = new Map();
  for (const post of posts) {
    for (const location of safeArray(post.locations)) {
      if (!location?.country) continue;
      const current = totals.get(location.country) || { value: 0, flag: location.flag || "" };
      current.value += safeNumber(location.value);
      totals.set(location.country, current);
    }
  }

  return {
    data: [...totals.entries()].map(([country, item]) => ({
      country,
      flag: item.flag || "",
      value: item.value,
      change: "0%",
      up: true,
    })),
  };
}

async function getAnalyticsAudienceBreakdown() {
  const snapshot = await getLatestMarketingAnalyticsSnapshot();
  const saved = safeObject(snapshot?.audienceBreakdown, null);
  if (saved) {
    return {
      total: safeNumber(saved.total),
      change: saved.change || "0%",
      breakdown: safeArray(saved.breakdown),
    };
  }

  const posts = await adminPrisma.marketing_social_posts.findMany({
    where: { status: { not: "Deleted" } },
  });
  return buildAudienceOverview(posts);
}

async function getAnalyticsConversionFunnel() {
  const snapshot = await getLatestMarketingAnalyticsSnapshot();
  const saved = safeObject(snapshot?.conversionFunnel, null);
  if (saved) {
    return {
      leads: { users: safeNumber(saved.leads?.users), percent: safeNumber(saved.leads?.percent) },
      nurture: { users: safeNumber(saved.nurture?.users), percent: safeNumber(saved.nurture?.percent) },
      conversion: { users: safeNumber(saved.conversion?.users), percent: safeNumber(saved.conversion?.percent) },
    };
  }

  const [performanceRows, banners] = await Promise.all([
    adminPrisma.marketing_campaign_performance.findMany(),
    adminPrisma.marketing_banners.findMany(),
  ]);
  const leads =
    performanceRows.reduce((sum, row) => sum + safeNumber(row.totalReach), 0) +
    banners.reduce((sum, banner) => sum + safeNumber(banner.totalImpressions), 0);
  const nurture =
    performanceRows.reduce((sum, row) => sum + safeNumber(row.clicks), 0) +
    banners.reduce((sum, banner) => sum + safeNumber(banner.clicks), 0);
  const conversion =
    performanceRows.reduce((sum, row) => sum + safeNumber(row.conversions), 0) +
    banners.reduce((sum, banner) => sum + safeNumber(banner.signup), 0);
  const percent = (value) => (leads > 0 ? Math.round((value / leads) * 100) : 0);

  return {
    leads: { users: leads, percent: leads > 0 ? 100 : 0 },
    nurture: { users: nurture, percent: percent(nurture) },
    conversion: { users: conversion, percent: percent(conversion) },
  };
}

async function getAnalyticsWeeklyEngagement() {
  const snapshot = await getLatestMarketingAnalyticsSnapshot();
  const saved = safeObject(snapshot?.weeklyEngagement, null);
  if (saved) {
    return {
      data: safeArray(saved.data),
      change: saved.change || "0",
    };
  }

  const range = getThisWeekRange();
  const posts = await adminPrisma.marketing_social_posts.findMany({
    where: { status: { not: "Deleted" } },
  });
  const weekPosts = posts.filter((post) => isWithinRange(post.postedAt || post.scheduledFor || post.createdAt, range));
  if (!weekPosts.length) return { data: [], change: "0" };

  return {
    data: buildWeeklyEngagement(weekPosts).filter((item) => item.value > 0),
    change: "+0",
  };
}

async function getAnalyticsPerformanceData() {
  const snapshot = await getLatestMarketingAnalyticsSnapshot();
  const saved = safeObject(snapshot?.performanceData, null);
  if (saved) {
    return {
      totalViews: safeNumber(saved.totalViews),
      change: saved.change || "0%",
      likes: normalizeKpi(saved.likes),
      reposts: normalizeKpi(saved.reposts),
      comments: normalizeKpi(saved.comments),
    };
  }

  const posts = await adminPrisma.marketing_social_posts.findMany({
    where: { status: { not: "Deleted" } },
  });
  const totalViews = posts.reduce((sum, post) => sum + safeNumber(post.views), 0);
  const likes = posts.reduce((sum, post) => sum + safeNumber(post.totalLikes), 0);
  const comments = posts.reduce((sum, post) => sum + safeNumber(post.comments), 0);
  const reposts = posts.reduce(
    (sum, post) => sum + safeNumber(safeObject(post.performance, {}).reposts),
    0,
  );

  return {
    totalViews,
    change: "0%",
    likes: { value: likes, change: "0%", up: true },
    reposts: { value: reposts, change: "0%", up: false },
    comments: { value: comments, change: "0%", up: true },
  };
}

async function getAnalyticsPlatformIntegrations() {
  return {
    data: [
      { platform: "Google Ads", connected: false },
      { platform: "Twitter Ads", connected: false },
      { platform: "Facebook Ads", connected: false },
      { platform: "Instagram Ads", connected: false },
    ],
  };
}
module.exports = {
  formatDateDDMMYY,
  formatDateYYYYMMDD,
  formatMetric,
  safeArray,
  safeNumber,
  createCampaign,
  createContent,
  deleteCampaign,
  deleteContent,
  duplicateCampaign,
  getCampaign,
  getCampaignPerformance,
  getCampaignTeam,
  getCampaignTimeline,
  getContent,
  getContentPerformance,
  getContentReport,
  listCampaigns,
  listContent,
  updateCampaign,
  updateCampaignStatus,
  updateContent,
  updatePromotion,
  updateBannerStatus,
  updateBanner,
  stringifyPlacement,
  stringifyDisplay,
  parseJsonArray,
  listPromotions,
  listBanners,
  getBanner,
  getAnalyticsWeeklyEngagement,
  getAnalyticsSocialStats,
  getAnalyticsPlatformIntegrations,
  getAnalyticsPerformanceData,
  getAnalyticsOverviewStats,
  getAnalyticsLocation,
  getAnalyticsConversionFunnel,
  getAnalyticsAudienceBreakdown,
  getAnalyticsAdsPerformance,
  formatNumber,
  deletePromotion,
  deleteBanner,
  createPromotion,
  createBanner,
  computePromotionStatus,
  computeBannerStatus,
  updateSocialPost,
  updateEmailTemplateRecipients,
  updateEmailTemplateNotification,
  updateEmailTemplateContent,
  updateEmailTemplate,
  searchEmailTemplateCustomers,
  safeObject,
  listSocialPosts,
  listSocialAccounts,
  listEmailTemplates,
  getSocialSchedule,
  getSocialPost,
  getSocialOverview,
  getSocialInsights,
  getEmailTemplate,
  generateEventCode,
  formatPlatformNumber,
  formatDateTimeYYYYMMDDHHMM,
  encryptSocialCredential,
  deleteSocialPost,
  deleteSocialAccount,
  deleteEmailTemplate,
  decryptSocialCredentialIfNeeded,
  createSocialSchedule,
  createSocialPost,
  createSocialAccount,
  createEmailTemplate,
};
