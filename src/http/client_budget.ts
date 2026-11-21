/**
 * What one client (address) may ask of the query service: a share of query
 * run time per sliding window, and a number of queries running or waiting at
 * once. It sits in front of the store, so it applies to every store kind.
 *
 * Time is charged for the run time of a query as the store reports it (see
 * `QueryOptions.onStart`; time spent waiting in a queue is not charged, and a
 * query refused as busy is free), including queries that time out. Time is
 * kept in one-second buckets, so a client costs at most `windowMs / 1000`
 * numbers; clients that have been idle for a window are forgotten, and the
 * table is capped.
 *
 * @module
 */
import { QueryLimitError } from "../types.ts";

/** Limits of {@link ClientBudget}; every field is optional. */
export interface BudgetOptions {
  /** Length of the sliding window (default 60 s). */
  windowMs?: number;
  /** Query time a client may use per window (default 20 s). */
  budgetMs?: number;
  /** Queries of one client running or waiting at once (default 12). */
  maxInFlight?: number;
  /** Clients remembered at most (default 4096). */
  maxClients?: number;
  /** Clock in milliseconds; replaced in tests. */
  now?: () => number;
}

/** One admitted query; call {@link Ticket.finish} exactly when it is over. */
export interface Ticket {
  /** The store starts to run the query. Throws when the budget is gone. */
  start(): void;
  /**
   * The query is over. `ran` is false when the store refused it without
   * running it (busy): then a query that never started costs nothing.
   */
  finish(ran?: boolean): void;
}

interface Client {
  /** Charged time per bucket end (ms since epoch, multiple of 1000). */
  buckets: Map<number, number>;
  inFlight: number;
  /** Start times of the queries that are running now. */
  running: Set<{ startedAt: number }>;
  lastSeen: number;
}

const BUCKET_MS = 1000;

export class ClientBudget {
  readonly #windowMs: number;
  readonly #budgetMs: number;
  readonly #maxInFlight: number;
  readonly #maxClients: number;
  readonly #now: () => number;
  /** Least recently used first. */
  readonly #clients = new Map<string, Client>();
  #lastSweep = 0;

  constructor(options: BudgetOptions = {}) {
    this.#windowMs = options.windowMs ?? 60_000;
    this.#budgetMs = options.budgetMs ?? 20_000;
    this.#maxInFlight = options.maxInFlight ?? 12;
    this.#maxClients = options.maxClients ?? 4096;
    this.#now = options.now ?? Date.now;
  }

  /** How many clients are remembered (for tests and monitoring). */
  get size(): number {
    return this.#clients.size;
  }

  /**
   * Admit a query of `key`.
   *
   * @throws {QueryLimitError} `budget`, with `retryAfter`, when the client has
   *   used its time or has too many queries in flight.
   */
  admit(key: string): Ticket {
    const now = this.#now();
    this.#sweep(now);
    const client = this.#client(key, now);
    if (client.inFlight >= this.#maxInFlight) {
      throw new QueryLimitError(
        "budget",
        `too many queries from your address at once (at most ${this.#maxInFlight}); try again in a moment`,
        1,
      );
    }
    this.#checkBudget(client, now);
    client.inFlight++;
    const budget = {
      now: this.#now,
      check: (c: Client, t: number) => this.#checkBudget(c, t),
      charge: (c: Client, a: number, b: number) => this.#charge(c, a, b),
    };
    let started: { startedAt: number } | undefined;
    let over = false;
    return {
      start() {
        if (over || started) return;
        // Not charged for its own run: check what the client has used so far.
        budget.check(client, budget.now());
        started = { startedAt: budget.now() };
        client.running.add(started);
      },
      finish(ran = true) {
        if (over) return;
        over = true;
        client.inFlight--;
        const end = budget.now();
        // A store that does not report starts ran the query from the moment
        // it was admitted.
        const startedAt = started?.startedAt ?? (ran ? now : end);
        if (started) client.running.delete(started);
        budget.charge(client, startedAt, end);
        client.lastSeen = end;
      },
    };
  }

  #client(key: string, now: number): Client {
    let client = this.#clients.get(key);
    if (client) {
      // Move to the back: least recently used goes first.
      this.#clients.delete(key);
    } else {
      if (this.#clients.size >= this.#maxClients) this.#evict();
      client = {
        buckets: new Map(),
        inFlight: 0,
        running: new Set(),
        lastSeen: now,
      };
    }
    client.lastSeen = now;
    this.#clients.set(key, client);
    return client;
  }

  /** Make room: drop the least recently used client with nothing in flight. */
  #evict(): void {
    for (const [key, client] of this.#clients) {
      if (client.inFlight === 0) {
        this.#clients.delete(key);
        return;
      }
    }
    // Everybody is busy: forget the oldest anyway; its tickets still work on
    // their own record.
    const oldest = this.#clients.keys().next();
    if (!oldest.done) this.#clients.delete(oldest.value);
  }

  /** Forget clients that have nothing in flight and nothing in the window. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < this.#windowMs / 4) return;
    this.#lastSweep = now;
    for (const [key, client] of this.#clients) {
      if (client.inFlight === 0 && now - client.lastSeen > this.#windowMs) {
        this.#clients.delete(key);
      }
    }
  }

  /** Spread the run `startedAt..end` over the buckets it touches. */
  #charge(client: Client, startedAt: number, end: number): void {
    // Charged to the bucket in which it ended: simple and conservative, since
    // the whole run then stays in the window until a window after its end.
    const ms = Math.max(0, end - startedAt);
    if (ms === 0) return;
    const bucket = Math.floor(end / BUCKET_MS) * BUCKET_MS + BUCKET_MS;
    client.buckets.set(bucket, (client.buckets.get(bucket) ?? 0) + ms);
  }

  #checkBudget(client: Client, now: number): void {
    let completed = 0;
    for (const [end, ms] of client.buckets) {
      if (end <= now - this.#windowMs) client.buckets.delete(end);
      else completed += ms;
    }
    let running = 0;
    for (const run of client.running) {
      running += Math.max(0, now - run.startedAt);
    }
    if (completed + running < this.#budgetMs) return;
    // Retry when enough of the completed time has left the window; if the
    // queries that run now are enough to exceed it, when they are over.
    let retryMs = 2000;
    const room = this.#budgetMs - running;
    if (room > 0) {
      let left = completed;
      for (const end of [...client.buckets.keys()].sort((a, b) => a - b)) {
        left -= client.buckets.get(end)!;
        if (left < room) {
          retryMs = end + this.#windowMs - now;
          break;
        }
      }
    }
    const seconds = Math.min(
      Math.ceil(this.#windowMs / 1000),
      Math.max(1, Math.ceil(retryMs / 1000)),
    );
    throw new QueryLimitError(
      "budget",
      `your address has used its share of query time (${
        this.#budgetMs / 1000
      } seconds per ${
        this.#windowMs / 1000
      } seconds); try again in ${seconds} seconds`,
      seconds,
    );
  }
}
