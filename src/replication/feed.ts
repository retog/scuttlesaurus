/**
 * Everything the replicator does with one relay: keep the connection,
 * backfill the history of the authors assigned to it page by page, and keep
 * live subscriptions open for what happens next.
 *
 * Live subscriptions are opened first, starting a little before "now", so that
 * nothing published while the history is being fetched is missed. The history
 * is requested backwards in time with `limit` and `until` (NIP-01) and each
 * completed page is recorded in the {@link SyncState}, so an interrupted
 * backfill resumes where it stopped.
 * @module
 */
import type { Filter, NostrEvent, RelayStatus } from "../types.ts";
import {
  type ConnectionSettings,
  describe,
  RelayConnection,
  type Subscription,
} from "./connection.ts";
import { type Ingest, parseEvent } from "./ingest.ts";
import type { ResolvedOptions } from "./options.ts";
import { missingRanges, type SyncState } from "./sync_state.ts";
import {
  horizonStart,
  liveFilter,
  rangeFilter,
  replaceableFilter,
  type Wanted,
} from "./wanted.ts";

/** Filters per `REQ`; relays commonly refuse more (NIP-11 `max_filters`). */
const MAX_FILTERS_PER_REQUEST = 10;

/** Which authors a relay is asked for, and how. */
export type Assignment = ReadonlyMap<string, Wanted>;

/** What a feed needs from the replicator. */
export interface FeedDependencies {
  ingest: Ingest;
  sync: SyncState;
  options: ResolvedOptions;
  /** Current unix time in seconds. */
  now(): number;
  /** The connection failed too often; the relay should leave the plan. */
  onGiveUp(url: string, error: string): void;
}

/** One request that is paged through. */
interface Task {
  authors: string[];
  wanted: Wanted;
  /** `replaceable`: current versions, no time limit. `range`: regular events. */
  type: "replaceable" | "range";
  /** For ranges: the covered time this request is about. */
  from: number;
  to: number;
  /** Keys in `#progress` that this task settles. */
  keys: string[];
  /** Abort the page in flight. */
  cancel?: () => void;
}

/** A live `REQ` and the (author, recipe) pairs it serves. */
interface LiveGroup {
  subscription: Subscription;
  members: Set<string>;
  authors: Set<string>;
  since: number;
}

interface Page {
  count: number;
  oldest: number;
}

const memberKey = (author: string, wanted: Wanted) => `${author}|${wanted.key}`;

/** The connection to one relay and the work done over it. */
export class RelayFeed {
  readonly url: string;
  readonly #deps: FeedDependencies;
  readonly #connection: RelayConnection;
  readonly #running = new Set<Promise<void>>();
  readonly #queue: Task[] = [];
  readonly #active = new Set<Task>();
  /** `queued` or `done` per piece of work, so that it is requested once. */
  readonly #progress = new Map<string, "queued" | "done">();
  readonly #live = new Map<string, LiveGroup>();
  /** Members of live groups: member key to group id. */
  readonly #liveMembers = new Map<string, string>();
  #assignment: Assignment = new Map();
  #started = false;
  #closed = false;
  #received = 0;
  #lastError: string | undefined;
  #droppedAt: number | undefined;
  #failures = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #groupCounter = 0;

  constructor(url: string, deps: FeedDependencies) {
    this.url = url;
    this.#deps = deps;
    const { options } = deps;
    const settings: ConnectionSettings = {
      backoffBaseMs: options.backoffBaseMs,
      backoffMaxMs: options.backoffMaxMs,
      maxFailures: options.maxFailures,
      connectTimeoutMs: options.connectTimeoutMs,
      stableMs: options.stableMs,
      reconnect: true,
    };
    this.#connection = new RelayConnection(url, settings, {
      onOpen: () => this.#sync(),
      onLost: () => this.#onLost(),
      onGiveUp: (error) => deps.onGiveUp(url, error),
    });
  }

  /** The connection, for publishing over it while it is open. */
  get connection(): RelayConnection {
    return this.#connection;
  }

  /**
   * Change which authors this relay is asked for. The first call connects.
   * Authors that are new here are backfilled; those already covered are not
   * requested again.
   */
  assign(assignment: Assignment): void {
    if (this.#closed) return;
    this.#assignment = assignment;
    if (!this.#started) {
      this.#started = true;
      this.#connection.connect();
    } else {
      this.#sync();
    }
  }

  /** Cheap snapshot for the status API. */
  status(): RelayStatus {
    const lastError = this.#connection.lastError ?? this.#lastError;
    return {
      url: this.url,
      state: this.#connection.state,
      authors: this.#assignment.size,
      eventsReceived: this.#received,
      backfilling: this.#queue.length + this.#active.size > 0,
      ...(lastError === undefined ? {} : { lastError }),
    };
  }

  /**
   * Record in the sync state that live subscriptions have covered the time
   * since they were opened, up to now.
   */
  recordLive(): void {
    const now = this.#deps.now();
    for (const group of this.#live.values()) {
      this.#deps.sync.extend(this.url, group.authors, group.since, now, true);
    }
  }

  /** Stop all work, close the connection and wait until nothing is left. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.recordLive();
    this.#dropWork();
    await this.#connection.close();
    await Promise.allSettled([...this.#running]);
  }

  // -- reconciling what is wanted with what is running ----------------------

  #sync(): void {
    if (this.#closed || !this.#connection.connected) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const now = this.#deps.now();
    this.#reconcileLive(now);
    this.#planTasks(now);
    this.#pump();
  }

  #onLost(): void {
    this.recordLive();
    if (this.#live.size > 0) this.#droppedAt = this.#deps.now();
    this.#dropWork();
  }

  /** Forget everything that was running on the lost or closed connection. */
  #dropWork(): void {
    for (const task of [...this.#active]) task.cancel?.();
    this.#queue.length = 0;
    this.#active.clear();
    this.#progress.clear();
    for (const group of this.#live.values()) group.subscription.close();
    this.#live.clear();
    this.#liveMembers.clear();
  }

  /** Close live groups nobody wants any more, open groups for new authors. */
  #reconcileLive(now: number): void {
    const wanted = new Set(
      [...this.#assignment].map(([author, w]) => memberKey(author, w)),
    );
    for (const [id, group] of [...this.#live]) {
      const stale = [...group.members].every((member) => !wanted.has(member));
      if (stale) this.#endGroup(id, group);
    }

    const byRecipe = new Map<string, { wanted: Wanted; authors: string[] }>();
    for (const [author, w] of this.#assignment) {
      if (this.#liveMembers.has(memberKey(author, w))) continue;
      const entry = byRecipe.get(w.key) ?? { wanted: w, authors: [] };
      entry.authors.push(author);
      byRecipe.set(w.key, entry);
    }
    if (byRecipe.size === 0) return;

    // Pick up where the connection dropped, a little earlier for late events.
    const since = (this.#droppedAt ?? now) - this.#deps.options.overlapSeconds;
    const pieces: { filter: Filter; wanted: Wanted; authors: string[] }[] = [];
    for (const { wanted, authors } of byRecipe.values()) {
      for (
        const chunk of chunked(authors, this.#deps.options.authorsPerFilter)
      ) {
        pieces.push({
          filter: liveFilter(wanted, chunk, since),
          wanted,
          authors: chunk,
        });
      }
    }
    for (const request of chunked(pieces, MAX_FILTERS_PER_REQUEST)) {
      this.#openLive(request, Math.max(0, since));
    }
    this.#droppedAt = undefined;
  }

  #openLive(
    pieces: { filter: Filter; wanted: Wanted; authors: string[] }[],
    since: number,
  ): void {
    const id = `live${++this.#groupCounter}`;
    const members = new Set<string>();
    const authors = new Set<string>();
    for (const piece of pieces) {
      for (const author of piece.authors) {
        members.add(memberKey(author, piece.wanted));
        if (piece.wanted.ranged) authors.add(author);
      }
    }
    const subscription = this.#connection.subscribe(
      pieces.map((piece) => piece.filter),
      {
        onEvent: (raw) => {
          const event = parseEvent(raw);
          if (event) void this.#receive(event, undefined);
        },
        onEose: () => {},
        onClosed: (reason) => {
          // The relay refused or ended the subscription; try again later.
          const group = this.#live.get(id);
          if (!group) return;
          this.#endGroup(id, group);
          this.#droppedAt = Math.min(
            this.#droppedAt ?? Infinity,
            group.since + this.#deps.options.overlapSeconds,
          );
          this.#lastError = `subscription closed: ${reason}`;
          this.#retryLater();
        },
      },
    );
    if (!subscription) return;
    this.#live.set(id, { subscription, members, authors, since });
    for (const member of members) this.#liveMembers.set(member, id);
  }

  /** Stop a live group, keeping what it covered in the sync state. */
  #endGroup(id: string, group: LiveGroup): void {
    this.#deps.sync.extend(
      this.url,
      group.authors,
      group.since,
      this.#deps.now(),
      true,
    );
    group.subscription.close();
    this.#live.delete(id);
    for (const member of group.members) this.#liveMembers.delete(member);
  }

  /** Work out what is missing and queue it. Idempotent. */
  #planTasks(now: number): void {
    const { options, sync } = this.#deps;
    const byRecipe = new Map<string, { wanted: Wanted; authors: string[] }>();
    for (const [author, wanted] of this.#assignment) {
      const entry = byRecipe.get(wanted.key) ?? { wanted, authors: [] };
      entry.authors.push(author);
      byRecipe.set(wanted.key, entry);
    }

    for (const { wanted, authors } of byRecipe.values()) {
      if (wanted.replaceable.length > 0) {
        const todo = authors.filter((a) =>
          !this.#progress.has(`replaceable|${a}|${wanted.key}`)
        );
        for (const batch of chunked(todo, options.authorsPerFilter)) {
          this.#enqueue({
            authors: batch,
            wanted,
            type: "replaceable",
            from: 0,
            to: 0,
            keys: batch.map((a) => `replaceable|${a}|${wanted.key}`),
          });
        }
      }
      if (!wanted.ranged) continue;

      const horizon = horizonStart(wanted, now);
      const gaps: { author: string; from: number; to: number; key: string }[] =
        [];
      for (const author of authors) {
        const ranges = missingRanges(
          sync.get(this.url, author),
          horizon,
          now,
          options.overlapSeconds,
        );
        ranges.forEach((range, index) => {
          const key = `range|${author}|${wanted.key}|${
            index === 0 ? "newer" : "older"
          }`;
          if (!this.#progress.has(key)) gaps.push({ author, ...range, key });
        });
      }
      // Authors with similar gaps share a request: sort by where the gap
      // starts, so that a batch over-fetches little.
      for (const newer of [true, false]) {
        const group = gaps.filter((gap) => (gap.to === now) === newer)
          .sort((a, b) => a.from - b.from);
        for (const batch of chunked(group, options.authorsPerFilter)) {
          this.#enqueue({
            authors: batch.map((gap) => gap.author),
            wanted,
            type: "range",
            from: Math.min(...batch.map((gap) => gap.from)),
            to: Math.max(...batch.map((gap) => gap.to)),
            keys: batch.map((gap) => gap.key),
          });
        }
      }
    }
  }

  #enqueue(task: Task): void {
    for (const key of task.keys) this.#progress.set(key, "queued");
    this.#queue.push(task);
  }

  // -- running tasks -------------------------------------------------------

  /** Live subscriptions come first; backfill uses the slots that are left. */
  #pump(): void {
    const limit = Math.max(
      1,
      this.#deps.options.maxSubscriptions - this.#live.size,
    );
    while (
      !this.#closed && this.#connection.connected && this.#queue.length > 0 &&
      this.#active.size < limit
    ) {
      const task = this.#queue.shift()!;
      this.#active.add(task);
      const run: Promise<void> = this.#execute(task).finally(() => {
        this.#active.delete(task);
        this.#running.delete(run);
        this.#pump();
      });
      this.#running.add(run);
    }
  }

  async #execute(task: Task): Promise<void> {
    const { sync, options } = this.#deps;
    const authors = task.authors.filter((a) => this.#assignment.has(a));
    try {
      let until: number | undefined = task.type === "range"
        ? task.to
        : undefined;
      while (authors.length > 0) {
        const filter = task.type === "range"
          ? rangeFilter(
            task.wanted,
            authors,
            task.from,
            until!,
            options.pageSize,
          )
          : replaceableFilter(task.wanted, authors, until, options.pageSize);
        const page = await this.#page(task, filter, authors);
        if (!page) {
          this.#fail(task);
          return;
        }
        if (page.count === 0) break;
        // Pages arrive newest first, so everything from the top of the range
        // down to the oldest event of this page is now covered.
        if (task.type === "range") {
          sync.extend(this.url, authors, page.oldest, task.to, true);
        }
        const next = page.oldest - 1;
        if (next < task.from) break;
        until = next;
      }
      if (task.type === "range") {
        sync.extend(this.url, authors, task.from, task.to, false);
      }
      for (const key of task.keys) this.#progress.set(key, "done");
      this.#failures = 0;
    } catch (error) {
      this.#lastError = describe(error);
      this.#fail(task);
    }
  }

  /** One request, from `REQ` to `EOSE`; undefined when it did not complete. */
  #page(
    task: Task,
    filter: Filter,
    authors: string[],
  ): Promise<Page | undefined> {
    return new Promise((resolve) => {
      const wanted = new Set(authors);
      const lowest = task.type === "range" ? task.from : 0;
      const highest = filter.until ?? Number.MAX_SAFE_INTEGER;
      const stored: Promise<unknown>[] = [];
      let count = 0;
      let oldest = Number.MAX_SAFE_INTEGER;
      let settled = false;

      const finish = (complete: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        task.cancel = undefined;
        subscription?.close();
        if (error) this.#lastError = error;
        if (!complete) return resolve(undefined);
        // Coverage may only be recorded once every event of the page is stored.
        Promise.allSettled(stored).then(() => resolve({ count, oldest }));
      };
      const timer = setTimeout(
        () => finish(false, "timed out waiting for EOSE"),
        this.#deps.options.pageTimeoutMs,
      );

      const subscription = this.#connection.subscribe([filter], {
        onEvent: (raw) => {
          const event = parseEvent(raw);
          if (
            !event || !wanted.has(event.pubkey) ||
            event.created_at < lowest || event.created_at > highest
          ) return;
          count++;
          oldest = Math.min(oldest, event.created_at);
          stored.push(this.#receive(event, wanted));
        },
        onEose: () => finish(true),
        onClosed: (reason) => finish(false, `request closed: ${reason}`),
      });
      if (!subscription) {
        finish(false, "not connected");
        return;
      }
      task.cancel = () => finish(false);
    });
  }

  /** A task that did not complete is forgotten, to be planned again later. */
  #fail(task: Task): void {
    for (const key of task.keys) this.#progress.delete(key);
    if (!this.#closed && this.#connection.connected) this.#retryLater();
  }

  #retryLater(): void {
    if (this.#retryTimer !== undefined || this.#closed) return;
    if (!this.#connection.connected) return; // reconnecting will sync anyway
    const { backoffBaseMs, backoffMaxMs } = this.#deps.options;
    const delay = Math.min(backoffBaseMs * 2 ** this.#failures, backoffMaxMs);
    this.#failures++;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#sync();
    }, delay);
  }

  /** Hand an event to the store; ignore authors nobody asked this relay for. */
  #receive(
    event: NostrEvent,
    requested: ReadonlySet<string> | undefined,
  ): Promise<void> {
    if (!this.#assignment.has(event.pubkey)) return Promise.resolve();
    if (requested && !requested.has(event.pubkey)) return Promise.resolve();
    return this.#deps.ingest.handle(this.url, event).then((outcome) => {
      if (outcome === "stored") this.#received++;
    });
  }
}

/** Split a list into chunks of at most `size`. */
function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) {
    chunks.push(items.slice(i, i + Math.max(1, size)));
  }
  return chunks;
}
