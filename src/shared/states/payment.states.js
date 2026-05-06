const ApiError = require("../utils/ApiError");

const PAYMENT_STATES = {
  INITIATED: "pending",
  SUCCESS: "completed",
  FAILED: "failed",
  REFUNDED: "refunded",
};

const VALID_TRANSITIONS = {
  [PAYMENT_STATES.INITIATED]: [PAYMENT_STATES.SUCCESS, PAYMENT_STATES.FAILED],
  [PAYMENT_STATES.SUCCESS]: [PAYMENT_STATES.REFUNDED],
  [PAYMENT_STATES.FAILED]: [],
  [PAYMENT_STATES.REFUNDED]: [],
};

const validatePaymentTransition = (from, to) => {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) throw new ApiError(400, `Unknown payment state: ${from}`);
  if (!allowed.includes(to)) {
    throw new ApiError(400, `Invalid payment transition: ${from} → ${to}`);
  }
};

module.exports = { PAYMENT_STATES, validatePaymentTransition };
