/**
 * One start-to-stop life of the replicator: loads the sync state, plans which
 * relays to connect to, keeps a {@link RelayFeed} per planned relay and
 * replans, debounced, when the social graph or a relay list changes.
 * Contract: `docs/ARCHITECTURE.md`, "Replication".
 * @module
 */
import type { Config, EventStore, RelayStatus, SocialGraph } from "../types.ts";
import { coalesce } from "./coalesce.ts";
import { describe, type RelayConnection } from "./connection.ts";
import { RelayFeed } from "./feed.ts";
import { Ingest } from "./ingest.ts";
import type { ResolvedOptions } from "./options.ts";
import { planRelays } from "./plan.ts";
import { SyncState } from "./sync_state.ts";
import { discoveryWanted, fullWanted, type Wanted } from "./wanted.ts";

/** NIP-65 relay list: a change moves where an author is fetched from. */
const RELAY_LIST = 10002;

/** The pieces a run is made of. */
export interface RunDependencies {
  events: EventStore;
  graph: SocialGraph;
  config: Config;
  options: ResolvedOptions;
}

/** A relay that was left out of the plan after repeated failures. */
interface GivenUp {
  until: number;
  status: RelayStatus;
}

/** The unix time in seconds. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The authors in range, with the owner always among them at distance 0. */
export function effectiveAuthors(
  graph: SocialGraph,
  config: Config,
): Map<string, number> {
  const authors = new Map(graph.authors());
  if (config.owner && !authors.has(config.owner)) authors.set(config.owner, 0);
  return authors;
}

/** Replication from `begin()` to `close()`. */
export class Run {
  readonly #deps: RunDependencies;
  readonly #ingest: Ingest;
  readonly #feeds = new Map<string, RelayFeed>();
  readonly #givenUp = new Map<string, GivenUp>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #unsubscribe: (() => void)[] = [];
  readonly #replan: () => Promise<void>;
  #sync: SyncState | undefined;
  #replanTimer: ReturnType<typeof setTimeout> | undefined;
  #beginning: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(deps: RunDependencies) {
    this.#deps = deps;
    this.#ingest = new Ingest(deps.events);
    this.#replan = coalesce(() => this.#planAndApply());
  }

  /** Start once `after` has finished (the previous run's shutdown). */
  begin(after: Promise<void>): void {
    this.#beginning = this.#begin(after);
  }

  /** The open connection to a relay, for publishing over it. */
  openConnection(url: string): RelayConnection | undefined {
    const connection = this.#feeds.get(url)?.connection;
    return connection?.connected ? connection : undefined;
  }

  /** Status of every relay this run has, including those given up on. */
  relayStatuses(): RelayStatus[] {
    const statuses = [...this.#feeds.values()].map((feed) => feed.status());
    for (const [url, entry] of this.#givenUp) {
      if (!this.#feeds.has(url)) statuses.push(entry.status);
    }
    return statuses;
  }

  /** Close every connection, cancel every timer, flush the sync state. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#replanTimer);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe.length = 0;
    await this.#beginning;
    await this.#replan();
    await this.#closeFeeds([...this.#feeds.keys()]);
    await this.#ingest.idle();
    await this.#sync?.close();
  }

  async #begin(after: Promise<void>): Promise<void> {
    await after;
    if (this.#closed) return;
    const { config, options, graph, events } = this.#deps;
    this.#sync = await SyncState.open(config.dataDir, {
      flushMs: options.stateFlushMs,
      beforeSave: () => {
        for (const feed of this.#feeds.values()) feed.recordLive();
      },
    });
    if (this.#closed) return;
    // Coverage older than every horizon in use is worth nothing.
    const days = config.replication.horizonDays.slice(1);
    if (days.length > 0 && days.every((d) => d > 0)) {
      this.#sync.prune(nowSeconds() - Math.max(...days) * 86400);
    }
    this.#unsubscribe.push(
      graph.onChange(() => this.#requestReplan()),
      events.subscribe((event, info) => {
        // Where somebody publishes decides which relay is asked for them.
        if (
          info.stored && event.kind === RELAY_LIST &&
          effectiveAuthors(graph, config).has(event.pubkey)
        ) this.#requestReplan();
      }),
    );
    await this.#replan();
  }

  /** Replan after the debounce; many triggers in a row make one plan. */
  #requestReplan(): void {
    if (this.#closed) return;
    clearTimeout(this.#replanTimer);
    this.#replanTimer = setTimeout(() => {
      this.#replanTimer = undefined;
      void this.#replan();
    }, this.#deps.options.replanDebounceMs);
  }

  async #planAndApply(): Promise<void> {
    if (this.#closed || !this.#sync) return;
    try {
      const { events, graph, config, options } = this.#deps;
      const authors = effectiveAuthors(graph, config);
      const pubkeys = [...authors.keys()];
      const [relayLists, scores] = await Promise.all([
        events.relayLists(pubkeys),
        events.relayScores(pubkeys),
      ]);
      if (this.#closed) return;

      const now = Date.now();
      for (const [url, entry] of this.#givenUp) {
        if (entry.until <= now) this.#givenUp.delete(url);
      }
      const plan = planRelays({
        authors,
        relayLists,
        scores,
        bootstrapRelays: config.replication.bootstrapRelays,
        maxRelays: config.replication.maxRelays,
        excluded: new Set(this.#givenUp.keys()),
        allowPrivateRelays: config.replication.allowPrivateRelays,
      });

      const assignments = new Map<string, Map<string, Wanted>>();
      for (const [url, planned] of plan) {
        const assignment = new Map<string, Wanted>();
        for (const author of planned.authors) {
          assignment.set(
            author,
            fullWanted(
              authors.get(author) ?? 1,
              config.replication.horizonDays,
            ),
          );
        }
        if (planned.bootstrap) {
          for (const author of authors.keys()) {
            if (!assignment.has(author)) {
              assignment.set(author, discoveryWanted(author === config.owner));
            }
          }
        }
        assignments.set(url, assignment);
      }

      await this.#closeFeeds(
        [...this.#feeds.keys()].filter((url) => !assignments.has(url)),
      );
      if (this.#closed) return;
      for (const [url, assignment] of assignments) {
        let feed = this.#feeds.get(url);
        if (!feed) {
          feed = new RelayFeed(url, {
            ingest: this.#ingest,
            sync: this.#sync,
            options,
            now: nowSeconds,
            onGiveUp: (relay, error) => this.#giveUp(relay, error),
          });
          this.#feeds.set(url, feed);
        }
        feed.assign(assignment);
      }
    } catch (error) {
      console.error("replication: planning failed:", describe(error));
    }
  }

  async #closeFeeds(urls: string[]): Promise<void> {
    const feeds = urls.flatMap((url) => {
      const feed = this.#feeds.get(url);
      this.#feeds.delete(url);
      return feed ? [feed] : [];
    });
    await Promise.all(feeds.map((feed) => feed.close()));
  }

  /** A relay failed too often: leave it out of the plan for a while. */
  #giveUp(url: string, error: string): void {
    if (this.#closed) return;
    const feed = this.#feeds.get(url);
    const { excludeMs } = this.#deps.options;
    this.#givenUp.set(url, {
      until: Date.now() + excludeMs,
      status: {
        ...(feed?.status() ?? {
          url,
          authors: 0,
          eventsReceived: 0,
          backfilling: false,
        }),
        state: "closed",
        lastError: error,
      },
    });
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#givenUp.delete(url);
      this.#requestReplan();
    }, excludeMs);
    this.#timers.add(timer);
    this.#requestReplan();
  }
}
