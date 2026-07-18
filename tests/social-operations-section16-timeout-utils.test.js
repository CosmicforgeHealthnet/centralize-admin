const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  OperationTimeoutError,
  withReferencedTimeout,
} = require("../src/modules/marketing/social-operations/utils/timeout");

test("referenced timeout utility resolves successful operations", async () => {
  const result = await withReferencedTimeout(Promise.resolve("ok"), {
    timeoutMs: 50,
    operation: "success",
  });
  assert.equal(result, "ok");
});

test("referenced timeout utility preserves operation failures", async () => {
  const failure = new Error("original failure");
  await assert.rejects(
    withReferencedTimeout(Promise.reject(failure), {
      timeoutMs: 50,
      operation: "failure",
    }),
    (error) => error === failure,
  );
});

test("referenced timeout utility times out deterministically and aborts factory work", async () => {
  let aborted = false;
  await assert.rejects(
    withReferencedTimeout(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      {
        timeoutMs: 15,
        operation: "timeout",
      },
    ),
    (error) =>
      error instanceof OperationTimeoutError &&
      error.code === "SOCIAL_OPERATION_TIMEOUT" &&
      error.operation === "timeout",
  );
  assert.equal(aborted, true);
});

test("referenced timeout utility supports custom timeout errors", async () => {
  await assert.rejects(
    withReferencedTimeout(new Promise(() => {}), {
      timeoutMs: 10,
      operation: "custom",
      createTimeoutError: () => {
        const error = new Error("custom timeout");
        error.code = "CUSTOM_TIMEOUT";
        return error;
      },
    }),
    { code: "CUSTOM_TIMEOUT" },
  );
});

test("referenced timeout utility rejects on external abort signals", async () => {
  const controller = new AbortController();
  const promise = withReferencedTimeout(new Promise(() => {}), {
    timeoutMs: 1000,
    operation: "abort",
    signal: controller.signal,
  });
  const reason = new Error("external abort");
  controller.abort(reason);
  await assert.rejects(promise, reason);
});
