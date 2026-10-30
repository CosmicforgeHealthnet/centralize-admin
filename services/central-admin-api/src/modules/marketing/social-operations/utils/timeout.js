class OperationTimeoutError extends Error {
  constructor(message, { code = "SOCIAL_OPERATION_TIMEOUT", operation, timeoutMs } = {}) {
    super(message);
    this.name = "OperationTimeoutError";
    this.code = code;
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

function abortError(operation) {
  const error = new Error(`${operation || "operation"} aborted`);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function defaultTimeoutError({ operation, timeoutMs }) {
  return new OperationTimeoutError(`${operation || "operation"} timed out`, {
    operation,
    timeoutMs,
  });
}

function normalizeTimeout(timeoutMs) {
  const parsed = Number(timeoutMs);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function withReferencedTimeout(work, { timeoutMs, operation = "operation", createTimeoutError, signal } = {}) {
  const normalizedTimeoutMs = normalizeTimeout(timeoutMs);
  const controller = new AbortController();
  let externalAbortListener;
  let abortPromise;

  if (signal) {
    if (signal.aborted) {
      return Promise.reject(signal.reason || abortError(operation));
    }
    abortPromise = new Promise((_, reject) => {
      externalAbortListener = () => {
        const reason = signal.reason || abortError(operation);
        if (!controller.signal.aborted) controller.abort(reason);
        reject(reason);
      };
      signal.addEventListener("abort", externalAbortListener, { once: true });
    });
  }

  const cleanupExternalAbort = () => {
    if (signal && externalAbortListener) {
      signal.removeEventListener("abort", externalAbortListener);
    }
  };

  const promise = Promise.resolve().then(() =>
    typeof work === "function" ? work({ signal: controller.signal }) : work,
  );

  if (!normalizedTimeoutMs) {
    return promise.finally(cleanupExternalAbort);
  }

  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = (createTimeoutError || defaultTimeoutError)({
        operation,
        timeoutMs: normalizedTimeoutMs,
      });
      if (!controller.signal.aborted) controller.abort(error);
      reject(error);
    }, normalizedTimeoutMs);
  });

  return Promise.race([promise, timeoutPromise, abortPromise].filter(Boolean)).finally(() => {
    clearTimeout(timeout);
    cleanupExternalAbort();
  });
}

module.exports = {
  OperationTimeoutError,
  withReferencedTimeout,
};
