const ApiError = require("../utils/ApiError");

const CONSULTATION_STATES = {
  CREATED: "pending",
  SCHEDULED: "scheduled",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

const VALID_TRANSITIONS = {
  [CONSULTATION_STATES.CREATED]: [
    CONSULTATION_STATES.SCHEDULED,
    CONSULTATION_STATES.CANCELLED,
  ],
  [CONSULTATION_STATES.SCHEDULED]: [
    CONSULTATION_STATES.COMPLETED,
    CONSULTATION_STATES.CANCELLED,
  ],
  [CONSULTATION_STATES.COMPLETED]: [],
  [CONSULTATION_STATES.CANCELLED]: [],
};

const validateConsultationTransition = (from, to) => {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) throw new ApiError(400, `Unknown consultation state: ${from}`);
  if (!allowed.includes(to)) {
    throw new ApiError(400, `Invalid consultation transition: ${from} → ${to}`);
  }
};

module.exports = { CONSULTATION_STATES, validateConsultationTransition };
