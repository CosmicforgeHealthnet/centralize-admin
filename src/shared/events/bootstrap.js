const logger = require("../utils/logger");

const bootstrap = () => {
  require("../../modules/rtc/rtc.service");
  require("../../modules/logistics/logistics.service");
  require("../../modules/payments/payments.service");
  require("../../modules/notifications-service/notifications-service.service");
  require("../../modules/audit-service/audit-service.service");

  logger.info(
    "[IT Systems] All services bootstrapped — event listeners active",
  );
};

module.exports = bootstrap;