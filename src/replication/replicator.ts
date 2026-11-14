/**
 * The replicator: pulls the events of everybody in the social graph from the
 * relays they publish to (NIP-65 outbox model) and pushes local events out.
 * @module
 */
import type {
  Config,
  EventStore,
  NostrEvent,
  PublishResult,
  ReplicationStatus,
  Replicator,
  SocialGraph,
} from "../types.ts";
import { type ReplicatorOptions, resolveOptions } from "./options.ts";
import { publishEvent } from "./publish.ts";
import { effectiveAuthors, Run } from "./run.ts";

/** The implementation behind {@link createReplicator}. */
export class NodeReplicator implements Replicator {
  readonly #events: EventStore;
  readonly #graph: SocialGraph;
  readonly #config: Config;
  readonly #options: ReturnType<typeof resolveOptions>;
  #run: Run | undefined;
  /** The shutdown of the previous run; the next run starts after it. */
  #closing: Promise<void> = Promise.resolve();

  constructor(
    events: EventStore,
    graph: SocialGraph,
    config: Config,
    options?: ReplicatorOptions,
  ) {
    this.#events = events;
    this.#graph = graph;
    this.#config = config;
    this.#options = resolveOptions(options);
  }

  start(): void {
    if (this.#run) return;
    if (!this.#config.replication.enabled || !this.#config.owner) return;
    this.#run = new Run({
      events: this.#events,
      graph: this.#graph,
      config: this.#config,
      options: this.#options,
    });
    this.#run.begin(this.#closing);
  }

  stop(): Promise<void> {
    const run = this.#run;
    if (run) {
      this.#run = undefined;
      this.#closing = run.close().catch((error) => {
        console.error("replication: shutdown failed:", error);
      });
    }
    return this.#closing;
  }

  status(): ReplicationStatus {
    const authorsByHop: number[] = [];
    for (
      const distance of effectiveAuthors(this.#graph, this.#config).values()
    ) {
      authorsByHop[distance] = (authorsByHop[distance] ?? 0) + 1;
    }
    for (let i = 0; i < authorsByHop.length; i++) authorsByHop[i] ??= 0;
    return {
      enabled: this.#config.replication.enabled,
      running: this.#run !== undefined,
      authorsByHop,
      relays: this.#run?.relayStatuses() ?? [],
    };
  }

  publish(event: NostrEvent): Promise<PublishResult[]> {
    return publishEvent({
      events: this.#events,
      config: this.#config,
      options: this.#options,
      openConnection: (url) => this.#run?.openConnection(url),
    }, event);
  }
}
