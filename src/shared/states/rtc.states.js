const ApiError = require("../utils/ApiError");

const RTC_STATES = {
  CREATED: "scheduled",
  ACTIVE: "active",
  ENDED: "completed",
  CANCELLED: "cancelled",
};

const VALID_TRANSITIONS = {
  [RTC_STATES.CREATED]: [RTC_STATES.ACTIVE, RTC_STATES.CANCELLED],
  [RTC_STATES.ACTIVE]: [RTC_STATES.ENDED, RTC_STATES.CANCELLED],
  [RTC_STATES.ENDED]: [],
  [RTC_STATES.CANCELLED]: [],
};

const validateRTCTransition = (from, to) => {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) throw new ApiError(400, `Unknown RTC state: ${from}`);
  if (!allowed.includes(to)) {
    throw new ApiError(400, `Invalid RTC transition: ${from} → ${to}`);
  }
};

module.exports = { RTC_STATES, validateRTCTransition };
