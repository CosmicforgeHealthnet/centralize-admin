const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;
const UNSPECIFIED = "UNSPECIFIED";
const { Prisma } = require("../../../../generated/admin-client");

function normalizeCurrency(value, { allowUnspecified = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (allowUnspecified) return UNSPECIFIED;
    const error = new Error("currency is required");
    error.statusCode = 400;
    throw error;
  }

  const normalized = String(value).trim().toUpperCase();
  if (allowUnspecified && normalized === UNSPECIFIED) return UNSPECIFIED;
  if (!ISO_CURRENCY_REGEX.test(normalized)) {
    const error = new Error("currency must be an ISO 4217 code");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function isKnownCurrency(value) {
  return ISO_CURRENCY_REGEX.test(String(value || "").trim().toUpperCase());
}

function toMoneyNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

function safeDecimal(value, { allowNegative = true, allowZero = true, scale } = {}) {
  try {
    const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value));
    if (!decimal.isFinite()) throw new Error("amount must be finite");
    if (!allowNegative && decimal.isNegative()) throw new Error("amount must not be negative");
    if (!allowZero && decimal.isZero()) throw new Error("amount must be non-zero");
    return scale === undefined ? decimal : decimal.toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);
  } catch (error) {
    if (error.statusCode) throw error;
    const invalid = new Error("amount must be a valid decimal");
    invalid.statusCode = 400;
    throw invalid;
  }
}

function toMoneyDecimal(value, options = {}) {
  return safeDecimal(value, { ...options, scale: 2 });
}

const decimalAdd = (left, right) => safeDecimal(left).plus(safeDecimal(right));
const decimalSubtract = (left, right) => safeDecimal(left).minus(safeDecimal(right));
const decimalMultiply = (left, right) => safeDecimal(left).mul(safeDecimal(right));
function decimalDivide(left, right, { scale = 18 } = {}) {
  const divisor = safeDecimal(right);
  if (divisor.isZero()) return null;
  return safeDecimal(left).div(divisor).toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);
}
const decimalClamp = (value, minimum, maximum) => Prisma.Decimal.max(safeDecimal(minimum), Prisma.Decimal.min(safeDecimal(maximum), safeDecimal(value)));
const decimalCompare = (left, right) => safeDecimal(left).comparedTo(safeDecimal(right));
const decimalRound = (value, scale = 2) => safeDecimal(value).toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);

module.exports = {
  ISO_CURRENCY_REGEX,
  UNSPECIFIED,
  normalizeCurrency,
  isKnownCurrency,
  toMoneyNumber,
  toMoneyDecimal,
  safeDecimal,
  decimalAdd,
  decimalSubtract,
  decimalMultiply,
  decimalDivide,
  decimalClamp,
  decimalCompare,
  decimalRound,
};
