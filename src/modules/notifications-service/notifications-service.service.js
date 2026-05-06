const { mainPrisma } = require("../../shared/config/mainDatabase");
const eventBus = require("../../shared/events/eventBus");
const EVENTS = require("../../shared/events/events");
const logger = require("../../shared/utils/logger");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const NOTIFICATION_TEMPLATES = {
  [EVENTS.CONSULTATION_CREATED]: (payload) => ({
    userId: payload.patientId,
    type: "consultation",
    title: "Consultation Scheduled",
    message: "Your consultation has been scheduled successfully.",
  }),
  [EVENTS.CONSULTATION_STARTED]: (payload) => ({
    userId: payload.patientId,
    type: "consultation",
    title: "Consultation Started",
    message: "Your consultation is now live. Join your session.",
  }),
  [EVENTS.CONSULTATION_COMPLETED]: (payload) => ({
    userId: payload.patientId,
    type: "consultation",
    title: "Consultation Completed",
    message: "Your consultation has been completed.",
  }),
  [EVENTS.CONSULTATION_CANCELLED]: (payload) => ({
    userId: payload.patientId,
    type: "consultation",
    title: "Consultation Cancelled",
    message: "Your consultation has been cancelled.",
  }),
  [EVENTS.RTC_SESSION_STARTED]: (payload) => ({
    userId: payload.patientId,
    type: "rtc",
    title: "Session Started",
    message: "Your video session is now active.",
  }),
  [EVENTS.RTC_SESSION_ENDED]: (payload) => ({
    userId: payload.patientId,
    type: "rtc",
    title: "Session Ended",
    message: "Your video session has ended.",
  }),
  [EVENTS.RTC_SESSION_FAILED]: (payload) => ({
    userId: payload.patientId,
    type: "rtc",
    title: "Session Failed",
    message: "Your video session encountered an issue. Please try again.",
  }),
  [EVENTS.PRESCRIPTION_CREATED]: (payload) => ({
    userId: payload.patientId,
    type: "prescription",
    title: "Prescription Created",
    message: "A new prescription has been created for you.",
  }),
  [EVENTS.DELIVERY_ASSIGNED]: (payload) => ({
    userId: payload.patientId,
    type: "delivery",
    title: "Delivery Assigned",
    message: "Your prescription has been assigned for delivery.",
  }),
  [EVENTS.DELIVERY_COMPLETED]: (payload) => ({
    userId: payload.patientId,
    type: "delivery",
    title: "Delivery Completed",
    message: "Your prescription has been delivered successfully.",
  }),
  [EVENTS.DELIVERY_FAILED]: (payload) => ({
    userId: payload.patientId,
    type: "delivery",
    title: "Delivery Failed",
    message: "Your prescription delivery failed. Our team is looking into it.",
  }),
  [EVENTS.PAYMENT_SUCCESS]: (payload) => ({
    userId: payload.userId,
    type: "payment",
    title: "Payment Successful",
    message: "Your payment was processed successfully.",
  }),
  [EVENTS.PAYMENT_FAILED]: (payload) => ({
    userId: payload.userId,
    type: "payment",
    title: "Payment Failed",
    message: "Your payment could not be processed. Please try again.",
  }),
};

class NotificationsServiceService {
  constructor() {
    this._registerListeners();
  }

  _registerListeners() {
    Object.keys(NOTIFICATION_TEMPLATES).forEach((event) => {
      eventBus.subscribe(event, async (payload) => {
        await this._handleEvent(event, payload);
      });
    });
  }

  async _handleEvent(event, payload) {
    try {
      const template = NOTIFICATION_TEMPLATES[event];
      if (!template) return;

      const notification = template(payload);
      if (!notification.userId) {
        logger.warn(`[NotificationService] No userId for event: ${event}`);
        return;
      }

      await this._sendWithRetry(notification, event, 0);
    } catch (err) {
      logger.error(
        `[NotificationService] Unhandled error for event ${event}: ${err.message}`,
      );
    }
  }

  async _sendWithRetry(notification, event, attempt) {
    try {
      await mainPrisma.notifications.create({
        data: {
          userId: notification.userId,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          isRead: false,
        },
      });

      logger.info(
        `[NotificationService] Notification sent — event: ${event}, userId: ${notification.userId}`,
      );
    } catch (err) {
      logger.error(
        `[NotificationService] Failed to send notification — attempt ${attempt + 1}, event: ${event}`,
        { error: err.message },
      );

      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        await this._sendWithRetry(notification, event, attempt + 1);
      } else {
        logger.error(
          `[NotificationService] All retries exhausted for event: ${event}, userId: ${notification.userId}`,
        );
      }
    }
  }

  async getNotificationsForUser(userId, { page = 1, limit = 20 } = {}) {
    try {
      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        mainPrisma.notifications.findMany({
          where: { userId },
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            type: true,
            title: true,
            message: true,
            isRead: true,
            createdAt: true,
          },
        }),
        mainPrisma.notifications.count({ where: { userId } }),
      ]);

      return { data, total, page, limit };
    } catch (err) {
      logger.warn(
        "[NotificationService] getNotificationsForUser unavailable:",
        err.message,
      );
      return { data: [], total: 0, page, limit };
    }
  }

  async getNotificationStats() {
    try {
      const [total, unread] = await Promise.all([
        mainPrisma.notifications.count(),
        mainPrisma.notifications.count({ where: { isRead: false } }),
      ]);

      return { total, unread };
    } catch (err) {
      logger.warn(
        "[NotificationService] getNotificationStats unavailable:",
        err.message,
      );
      return { total: 0, unread: 0 };
    }
  }
}

module.exports = new NotificationsServiceService();
