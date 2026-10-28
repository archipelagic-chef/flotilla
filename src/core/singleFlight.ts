/**
 * Runs `run` one at a time (BL-230): a call while it runs is one more run after it, however many calls come meanwhile,
 * and each call's promise settles with a run that started after the call.
 */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  const call = (): Promise<void> => {
    if (!running) {
      running = run().finally(() => (running = undefined));
      return running;
    }
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return call();
      });
    return queued;
  };
  return call;
}
