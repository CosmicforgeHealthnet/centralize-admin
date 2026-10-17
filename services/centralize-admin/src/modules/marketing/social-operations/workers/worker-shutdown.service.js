function createWorkerShutdownController({ graceMs = 10_000 } = {}) {
  const inFlight = new Set();
  let stopping = false;

  function track(promise) {
    inFlight.add(promise);
    Promise.resolve(promise).finally(() => inFlight.delete(promise));
    return promise;
  }

  async function shutdown() {
    stopping = true;
    const deadline = Date.now() + graceMs;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);
    }
    return { stoppedClaiming: true, inFlightRemaining: inFlight.size };
  }

  return {
    get isStopping() {
      return stopping;
    },
    get inFlightCount() {
      return inFlight.size;
    },
    track,
    shutdown,
  };
}

module.exports = {
  createWorkerShutdownController,
};
