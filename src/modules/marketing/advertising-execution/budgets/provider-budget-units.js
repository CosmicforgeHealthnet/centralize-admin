const { decimal, toMicroUnits } = require("./money");

function convertProviderBudget(provider, value, { currency, allowZero = false } = {}) {
  if (["GOOGLE_ADS", "X"].includes(provider)) return toMicroUnits(value, { currency, allowZero });
  if (["META", "TIKTOK", "LINKEDIN"].includes(provider)) {
    return Object.freeze({ unit: "MAJOR_CURRENCY", value: decimal(value, { currency, allowZero }).toFixed(), currency });
  }
  throw new TypeError(`Unsupported budget provider: ${provider}`);
}

module.exports = { convertProviderBudget };
