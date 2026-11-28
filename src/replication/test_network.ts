/**
 * An in-process Nostr network for the replicator tests: upstream relays that
 * are real {@link createRelayServer}s on random local ports, and a downstream
 * node (store, social graph, replicator) that replicates from them. Not used
 * at runtime.
 * @module
 */
import { delay } from "@std/async/delay";
import { matchFilter } from "@nostr/tools/filter";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "@nostr/tools/pure";
import { createRelayServer } from "../relay/mod.ts";
import { createSocialGraph } from "../social/mod.ts";
import { openEventStore } from "../store/mod.ts";
import { MemoryTripleStore, staticGraph, testConfig } from "../testing/mod.ts";
import type {
  Config,
  EventStore,
  Filter,
  NostrEvent,
  Replicator,
  SocialGraph,
  TripleStore,
} from "../types.ts";
import { createReplicator } from "./mod.ts";
import type { ReplicatorOptions } from "./options.ts";

/** A key pair. */
export interface Person {
  secret: Uint8Array;
  pubkey: string;
}

/** Create `count` people with fresh keys. */
export function people(count: number): Person[] {
  return Array.from({ length: count }, () => {
    const secret = generateSecretKey();
    return { secret, pubkey: getPublicKey(secret) };
  });
}

/** The unix time in seconds, `daysAgo` days back. */
export function secondsAgo(days: number, extra = 0): number {
  return Math.floor(Date.now() / 1000) - Math.round(days * 86400) - extra;
}

/** Sign an event; `created_at` defaults to now. */
export function sign(
  who: Person,
  kind: number,
  options: { content?: string; tags?: string[][]; created_at?: number } = {},
): NostrEvent {
  const { id, pubkey, created_at, tags, content, sig } = finalizeEvent({
    kind,
    content: options.content ?? "",
    tags: options.tags ?? [],
    created_at: options.created_at ?? Math.floor(Date.now() / 1000),
  }, who.secret);
  // A plain copy: finalizeEvent marks its result as verified with a symbol,
  // which would let the replicator skip the verification we want exercised.
  return { id, pubkey, created_at, kind, tags, content, sig };
}

/** A kind 3 event following `followed`. */
export function follows(
  who: Person,
  followed: Person[],
  created_at?: number,
): NostrEvent {
  return sign(who, 3, {
    tags: followed.map((f) => ["p", f.pubkey]),
    created_at,
  });
}

/** A kind 10002 event naming write relays. */
export function writeRelays(
  who: Person,
  urls: string[],
  created_at?: number,
): NostrEvent {
  return sign(who, 10002, {
    tags: urls.map((url) => ["r", url, "write"]),
    created_at,
  });
}

/** An upstream relay with its store and a log of every REQ filter it received. */
export interface Upstream {
  url: string;
  store: EventStore;
  /** Every filter of every REQ, in order of arrival. */
  requests: Filter[];
  /** How many WebSocket connections were accepted so far. */
  accepted: number;
  /** Add events directly to the store, as if they had been published. */
  add(...events: NostrEvent[]): Promise<void>;
  close(): Promise<void>;
}

/** Options of {@link startUpstream}. */
export interface UpstreamOptions {
  /**
   * Answer queries with every version of replaceable events, as relays that
   * keep the history do, instead of the current ones only.
   */
  keepHistory?: boolean;
}

/**
 * Serve a relay that lets everybody in `allowed` publish to it.
 */
export async function startUpstream(
  allowed: Person[] = [],
  upstreamOptions: UpstreamOptions = {},
): Promise<Upstream> {
  const history: NostrEvent[] = [];
  // The relay only takes writes once it has an owner.
  const config = testConfig({ owner: people(1)[0].pubkey });
  const store = await openEventStore(new MemoryTripleStore(), config);
  const requests: Filter[] = [];
  const recording: EventStore = new Proxy(store, {
    get(target, property) {
      if (property === "query") {
        return (filters: Filter[]) => {
          requests.push(...filters.map((f) => structuredClone(f)));
          if (!upstreamOptions.keepHistory) return target.query(filters);
          const found = new Map<string, NostrEvent>();
          for (const filter of filters) {
            history
              .filter((e) => matchFilter(filter, e))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, filter.limit ?? Infinity)
              .forEach((e) => found.set(e.id, e));
          }
          return Promise.resolve([...found.values()]);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const graph = staticGraph(
    Object.fromEntries(allowed.map((p) => [p.pubkey, 1])),
  );
  const relay = createRelayServer({ events: recording, graph, config });
  let accepted = 0;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (request) => {
      accepted++;
      return relay.handleUpgrade(request);
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}/`,
    store,
    requests,
    get accepted() {
      return accepted;
    },
    async add(...events) {
      for (const event of events) {
        const result = await store.add(event);
        if (result.status === "rejected") throw new Error(result.reason);
        history.push(event);
      }
    },
    async close() {
      relay.close();
      await server.shutdown();
      await store.close();
    },
  };
}

/** A URL on which nothing listens. */
export async function deadRelayUrl(): Promise<string> {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    () => new Response("gone"),
  );
  const url = `ws://127.0.0.1:${server.addr.port}/`;
  await server.shutdown();
  return url;
}

/** Timings that make the replicator react within milliseconds. */
export const FAST: ReplicatorOptions = {
  replanDebounceMs: 20,
  backoffBaseMs: 10,
  backoffMaxMs: 80,
  excludeMs: 400,
  maxFailures: 4,
  connectTimeoutMs: 1000,
  pageTimeoutMs: 3000,
  publishTimeoutMs: 1000,
  stateFlushMs: 20,
  overlapSeconds: 0,
};

/** The node that replicates: its own store, graph and replicator. */
export interface Downstream {
  events: EventStore;
  graph: SocialGraph;
  config: Config;
  replicator: Replicator;
  dataDir: string;
  /** Stop everything and delete the data directory. */
  close(): Promise<void>;
}

/** Create a downstream node owned by `owner`, bootstrapping from the relays. */
export async function startDownstream(
  owner: Person | undefined,
  bootstrapRelays: string[],
  options: {
    replication?: Partial<Config["replication"]>;
    tuning?: ReplicatorOptions;
    dataDir?: string;
    start?: boolean;
    /** The triple store to use instead of a fresh in-process one. */
    triples?: TripleStore;
  } = {},
): Promise<Downstream> {
  const dataDir = options.dataDir ?? await Deno.makeTempDir();
  const config = testConfig({
    owner: owner?.pubkey,
    dataDir,
    replication: {
      ...testConfig().replication,
      enabled: true,
      // The test relays listen on 127.0.0.1, which relay lists may not name by default.
      allowPrivateRelays: true,
      bootstrapRelays,
      ...options.replication,
    },
  });
  const events = await openEventStore(
    options.triples ?? new MemoryTripleStore(),
    config,
  );
  const graph = createSocialGraph(events, config, { debounceMs: 20 });
  const replicator = createReplicator(events, graph, config, {
    ...FAST,
    ...options.tuning,
  });
  if (options.start ?? true) replicator.start();
  return {
    events,
    graph,
    config,
    replicator,
    dataDir,
    async close() {
      await replicator.stop();
      graph.close();
      await events.close();
      await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    },
  };
}

/** Wait until `condition` holds; fail with `what` after the deadline. */
export async function eventually(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

/** Ids among `events` that the store holds. */
export function held(store: EventStore, events: NostrEvent[]): string[] {
  return events.filter((e) => store.has(e.id)).map((e) => e.id);
}
