const { Prisma } = require("../../../../generated/admin-client");
const { executionError } = require("../execution.errors");

const CURRENCY_PRECISION = Object.freeze({ BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0, BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3 });
const MAX_MAJOR = new Prisma.Decimal("999999999999999.999999");

function normalizeCurrency(value) {
  const currency = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw executionError("INVALID_EXECUTION_PLAN", { field: "currency", reasonCode: "INVALID_OR_MISSING_CURRENCY" });
  return currency;
}

function decimal(value, { currency, allowZero = true } = {}) {
  if (typeof value === "number") throw executionError("INVALID_EXECUTION_PLAN", { field: "amount", reasonCode: "BINARY_FLOAT_MONEY_FORBIDDEN" });
  let amount;
  try { amount = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value)); } catch (_error) {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "amount", reasonCode: "INVALID_DECIMAL" });
  }
  if (!amount.isFinite() || amount.isNegative() || (!allowZero && amount.isZero()) || amount.greaterThan(MAX_MAJOR)) {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "amount", reasonCode: "MONEY_OUT_OF_RANGE" });
  }
  if (currency) {
    const precision = CURRENCY_PRECISION[normalizeCurrency(currency)] ?? 2;
    if (amount.decimalPlaces() > precision) throw executionError("INVALID_EXECUTION_PLAN", { field: "amount", reasonCode: "CURRENCY_PRECISION_EXCEEDED", precision });
  }
  return amount;
}

function toMicroUnits(value, options = {}) {
  const amount = decimal(value, options);
  const micros = amount.times("1000000");
  if (!micros.isInteger() || micros.greaterThan("9223372036854775807")) throw executionError("INVALID_EXECUTION_PLAN", { field: "amount", reasonCode: "MICRO_UNIT_OVERFLOW" });
  return Object.freeze({ unit: "MICROS", value: micros.toFixed(0), major: amount.toFixed() });
}

function fromMicroUnits(value) {
  if (!/^-?\d+$/.test(String(value))) throw executionError("INVALID_EXECUTION_PLAN", { field: "micros", reasonCode: "INVALID_MICRO_UNITS" });
  return new Prisma.Decimal(String(value)).dividedBy("1000000");
}

function percentageDelta(current, requested) {
  const before = decimal(current);
  const after = decimal(requested);
  if (before.isZero()) return null;
  return after.minus(before).dividedBy(before).times("100");
}

module.exports = { PrismaDecimal: Prisma.Decimal, CURRENCY_PRECISION, normalizeCurrency, decimal, toMicroUnits, fromMicroUnits, percentageDelta };
