/**
 * What the Blossom handlers share: the graph, the social graph, the live
 * configuration and a lock that serializes every write.
 * @module
 */
import type { Config, SocialGraph, TripleStore } from "../types.ts";

/** The dependencies of every Blossom handler. */
export interface Context {
  readonly triples: TripleStore;
  readonly graph: SocialGraph;
  /** The live configuration object; read fields at the time of use. */
  readonly config: Config;
  /**
   * Run a task after all earlier tasks have finished. Used around every
   * sequence that reads and then writes the graph or moves a blob file, so
   * that two requests cannot interleave between the check and the write.
   */
  serialize<T>(task: () => Promise<T>): Promise<T>;
}

/** A lock that runs tasks one at a time, in the order they were submitted. */
export function createSerializer(): Context["serialize"] {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** The current unix time in whole seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
