/**
 * The social graph object: holds the current distances, recomputes them on
 * request and, debounced, when the store accepts a follow or mute list that
 * matters. Contract: `docs/ARCHITECTURE.md`, "Social graph".
 * @module
 */
import type { Config, EventStore, NostrEvent, SocialGraph } from "../types.ts";
import { computeDistances } from "./distances.ts";

/** Tuning for {@link createSocialGraph}; the defaults suit production. */
export interface SocialGraphOptions {
  /**
   * Milliseconds to wait after a relevant follow or mute list was stored
   * before recomputing, so that a burst of lists causes one run.
   * Default 2000.
   */
  debounceMs?: number;
}

const FOLLOW_LIST = 3;
const MUTE_LIST = 10000;

/** A promise that is settled from outside. */
interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sameDistances(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [pubkey, distance] of a) {
    if (b.get(pubkey) !== distance) return false;
  }
  return true;
}

/** The implementation behind {@link createSocialGraph}. */
export class StoreSocialGraph implements SocialGraph {
  readonly #events: EventStore;
  readonly #config: Config;
  readonly #debounceMs: number;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;

  #distances: ReadonlyMap<string, number> = new Map();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  // Coalescing: at most one run is in flight; callers that arrive meanwhile
  // share `#next`, the single follow-up run that starts after the current one.
  #running = false;
  #next: Deferred | undefined;

  constructor(
    events: EventStore,
    config: Config,
    options: SocialGraphOptions = {},
  ) {
    this.#events = events;
    this.#config = config;
    this.#debounceMs = options.debounceMs ?? 2000;
    this.#unsubscribe = events.subscribe((event, info) => {
      if (info.stored && this.#isRelevant(event)) this.#schedule();
    });
  }

  distance(pubkey: string): number | undefined {
    return this.#distances.get(pubkey);
  }

  authors(): ReadonlyMap<string, number> {
    return this.#distances;
  }

  recompute(): Promise<void> {
    const waiters = this.#next ??= deferred();
    void this.#pump();
    return waiters.promise;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * A follow list matters when its author is within reach of the next hop (or
   * is the owner, whose list may arrive before the graph knows anybody); the
   * owner's mute list matters because it removes authors.
   */
  #isRelevant(event: NostrEvent): boolean {
    const { owner, replication } = this.#config;
    if (!owner) return false;
    if (event.kind === MUTE_LIST) return event.pubkey === owner;
    if (event.kind !== FOLLOW_LIST) return false;
    if (event.pubkey === owner) return replication.hops > 0;
    const distance = this.#distances.get(event.pubkey);
    return distance !== undefined && distance < replication.hops;
  }

  #schedule(): void {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.recompute().catch((error) => {
        console.error("social graph: recompute failed:", error);
      });
    }, this.#debounceMs);
  }

  /** Run recomputations one after the other until nobody is waiting. */
  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#next) {
        const waiters = this.#next;
        this.#next = undefined;
        try {
          await this.#run();
          waiters.resolve();
        } catch (error) {
          waiters.reject(error);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  async #run(): Promise<void> {
    const { owner, replication } = this.#config;
    const next = await computeDistances({
      owner,
      hops: replication.hops,
      maxAuthors: replication.maxAuthors,
      follows: (pubkeys) => this.#events.follows(pubkeys),
      mutes: (pubkey) => this.#events.mutes(pubkey),
    });
    if (sameDistances(this.#distances, next)) return;
    this.#distances = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("social graph: a change listener threw:", error);
      }
    }
  }
}
