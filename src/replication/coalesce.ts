/**
 * Single-flight execution: while a run is in progress, further requests merge
 * into one more run that starts when it ends.
 * @module
 */

/**
 * Wrap `task` so that it never runs twice at once. Calling the result while
 * the task runs makes it run once more afterwards, however many calls came in.
 * The returned promise resolves when the task is idle again; it never rejects,
 * `task` is expected to handle its own errors.
 */
export function coalesce(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await task();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
}
