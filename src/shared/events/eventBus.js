const EventEmitter = require("events");
const logger = require("../utils/logger");

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  publish(event, payload) {
    logger.info(`[EventBus] Publishing: ${event}`, { payload });
    this.emit(event, payload);
  }

  subscribe(event, handler) {
    this.on(event, async (payload) => {
      try {
        await handler(payload);
      } catch (err) {
        logger.error(`[EventBus] Handler failed for event: ${event}`, {
          error: err.message,
          payload,
        });
      }
    });
  }
}

module.exports = new EventBus();
