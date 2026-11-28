/**
 * Test helpers for the relay: a fake {@link EventStore} that is checked against
 * the interface at compile time, signed-event builders, a WebSocket client and
 * a function that serves a relay on a random local port. Not used at runtime.
 * @module
 */
import { matchFilters } from "@nostr/tools/filter";
import type { Filter } from "@nostr/tools/filter";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "@nostr/tools/pure";
import type {
  AddOptions,
  AddResult,
  Config,
  EventListenerInfo,
  EventStore,
  NostrEvent,
  RelayServer,
  SocialGraph,
  StoreStats,
  TripleStore,
} from "../types.ts";
import { staticGraph, testConfig } from "../testing/mod.ts";
import { createRelayServer } from "./mod.ts";

const byNewest = (a: NostrEvent, b: NostrEvent) =>
  b.created_at - a.created_at || (a.id < b.id ? 1 : -1);

const unused = (): never => {
  throw new Error("the TripleStore is not used by the relay tests");
};

const unusedTriples: TripleStore = {
  insert: unused,
  select: unused,
  ask: unused,
  query: unused,
  size: unused,
  close: () => Promise.resolve(),
};

type Listener = (event: NostrEvent, info: EventListenerInfo) => void;

/**
 * An in-memory {@link EventStore} that keeps events in an array. Ephemeral
 * events are announced but not stored. Queries can be held open to test races.
 */
export class FakeEventStore implements EventStore {
  readonly triples: TripleStore = unusedTriples;
  readonly #events: NostrEvent[] = [];
  readonly #listeners = new Set<Listener>();
  #hold: {
    gate: Promise<void>;
    markStarted: () => void;
    snapshot: boolean;
  } | undefined;

  /** The filters of every `query` and `count` call, in order. */
  readonly queries: Filter[][] = [];
  /** If set, the next `add` returns `rejected` with this reason. */
  nextRejection: string | undefined;
  /** If set, the next `query` throws with this message. */
  nextQueryError: string | undefined;

  /** Number of registered store listeners. */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  /**
   * Makes the next `query` wait until `release` is called; `started` resolves
   * when the query has begun. By default the result is read after the wait, so
   * events added meanwhile are part of it. With `snapshot`, the result is the
   * store as it was when the query began.
   */
  holdNextQuery(
    options: { snapshot?: boolean } = {},
  ): { started: Promise<void>; release: () => void } {
    let release = () => {};
    const gate = new Promise<void>((resolve) => release = resolve);
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => markStarted = resolve);
    this.#hold = { gate, markStarted, snapshot: options.snapshot === true };
    return { started, release };
  }

  /** The options of every `add` call, in order. */
  readonly addOptions: (AddOptions | undefined)[] = [];
  #addGate: Promise<void> | undefined;

  /**
   * Makes the next stored `add` report itself durable at once and resolve
   * only after `release`, like a store whose index is still rebuilding.
   */
  holdNextAdd(): { release: () => void } {
    let release = () => {};
    this.#addGate = new Promise<void>((resolve) => release = resolve);
    return { release };
  }

  async add(event: NostrEvent, options?: AddOptions): Promise<AddResult> {
    this.addOptions.push(options);
    const gate = this.#addGate;
    if (gate && this.nextRejection === undefined && !this.has(event.id)) {
      this.#addGate = undefined;
      options?.onDurable?.({ status: "stored" });
      await gate;
    }
    return this.#add(event);
  }

  #add(event: NostrEvent): Promise<AddResult> {
    if (this.nextRejection !== undefined) {
      const reason = this.nextRejection;
      this.nextRejection = undefined;
      return Promise.resolve({ status: "rejected", reason });
    }
    if (this.has(event.id)) return Promise.resolve({ status: "duplicate" });
    if (event.kind >= 20000 && event.kind <= 29999) {
      this.#notify(event, false);
      return Promise.resolve({ status: "ephemeral" });
    }
    this.#events.push(event);
    this.#notify(event, true);
    return Promise.resolve({ status: "stored" });
  }

  has(id: string): boolean {
    return this.#events.some((event) => event.id === id);
  }

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    this.queries.push(filters);
    const hold = this.#hold;
    this.#hold = undefined;
    const snapshot = hold?.snapshot ? this.#matching(filters) : undefined;
    if (hold) {
      hold.markStarted();
      await hold.gate;
    }
    if (this.nextQueryError !== undefined) {
      const message = this.nextQueryError;
      this.nextQueryError = undefined;
      throw new Error(message);
    }
    return snapshot ?? this.#matching(filters);
  }

  count(filters: Filter[]): Promise<number> {
    this.queries.push(filters);
    return Promise.resolve(
      this.#events.filter((event) => matchFilters(filters, event)).length,
    );
  }

  follows(_pubkeys: string[]): Promise<Map<string, string[]>> {
    return Promise.resolve(new Map());
  }

  mutes(_pubkey: string): Promise<string[]> {
    return Promise.resolve([]);
  }

  relayLists(
    _pubkeys: string[],
  ): Promise<Map<string, { read: string[]; write: string[] }>> {
    return Promise.resolve(new Map());
  }

  relayScores(_pubkeys: string[]): Promise<Map<string, Map<string, number>>> {
    return Promise.resolve(new Map());
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onRepaired(_listener: () => void): () => void {
    // Nothing is ever left to repair in an array.
    return () => {};
  }

  stats(): Promise<StoreStats> {
    return Promise.resolve({
      events: this.#events.length,
      triples: 0,
      authors: 0,
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Events matching the filters, newest first, honouring each `limit`. */
  #matching(filters: Filter[]): NostrEvent[] {
    const found = new Map<string, NostrEvent>();
    for (const filter of filters) {
      const limit = filter.limit ?? Infinity;
      this.#events
        .filter((event) => matchFilters([filter], event))
        .sort(byNewest)
        .slice(0, limit)
        .forEach((event) => found.set(event.id, event));
    }
    return [...found.values()].sort(byNewest);
  }

  #notify(event: NostrEvent, stored: boolean): void {
    for (const listener of [...this.#listeners]) listener(event, { stored });
  }
}

/** A Nostr key pair for tests. */
export interface TestKey {
  readonly secretKey: Uint8Array;
  readonly pubkey: string;
}

/** A fresh random key pair. */
export function keyPair(): TestKey {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

/**
 * A signed event. `createdAt` defaults to now, kind to 1, and content to a
 * random string so that events made in the same second are distinct.
 */
export function signedEvent(
  key: TestKey,
  options: {
    kind?: number;
    createdAt?: number;
    tags?: string[][];
    content?: string;
  } = {},
): NostrEvent {
  return finalizeEvent(
    {
      kind: options.kind ?? 1,
      created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
      tags: options.tags ?? [],
      content: options.content ?? crypto.randomUUID(),
    },
    key.secretKey,
  );
}

/** A WebSocket client that reads relay messages into a queue. */
export class RelayClient {
  readonly #socket: WebSocket;
  readonly #inbox: unknown[][] = [];
  readonly #waiters: Array<(message: unknown[]) => void> = [];
  readonly #closed: Promise<void>;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    let markClosed = () => {};
    this.#closed = new Promise<void>((resolve) => markClosed = resolve);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as unknown[];
      const waiter = this.#waiters.shift();
      if (waiter) waiter(message);
      else this.#inbox.push(message);
    };
    socket.onclose = () => markClosed();
  }

  /** Opens a connection to the relay URL. */
  static connect(url: string): Promise<RelayClient> {
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.onopen = () => resolve(new RelayClient(socket));
      socket.onerror = () => reject(new Error(`could not connect to ${url}`));
    });
  }

  /**
   * Sends a message. Arrays are JSON-encoded; strings and bytes are sent as
   * they are.
   */
  send(message: unknown[] | string | Uint8Array): void {
    this.#socket.send(
      Array.isArray(message) ? JSON.stringify(message) : message,
    );
  }

  /** Resolves when the connection is closed, by either side. */
  closed(): Promise<void> {
    return this.#closed;
  }

  /** The next message from the relay. Fails after three seconds. */
  next(): Promise<unknown[]> {
    const queued = this.#inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = (message: unknown[]) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("timed out waiting for a relay message"));
      }, 3000);
      this.#waiters.push(waiter);
    });
  }

  /** Reads messages until one whose type is `type`; returns all of them. */
  async until(type: string): Promise<unknown[][]> {
    const messages: unknown[][] = [];
    for (;;) {
      const message = await this.next();
      messages.push(message);
      if (message[0] === type) return messages;
    }
  }

  /** Closes the socket and waits until it is closed. */
  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close();
    await this.#closed;
  }
}

/** A relay served on a random local port, with its fixtures. */
export interface RelayHarness {
  readonly owner: TestKey;
  readonly friend: TestKey;
  readonly outsider: TestKey;
  readonly store: FakeEventStore;
  readonly config: Config;
  readonly graph: SocialGraph;
  /** Events handed to `onAccepted`, in order. */
  readonly accepted: NostrEvent[];
  readonly relay: RelayServer;
  readonly url: string;
  /** Opens a client that is closed when the harness is torn down. */
  connect(): Promise<RelayClient>;
}

/**
 * Serves a relay for the duration of `body` and shuts everything down
 * afterwards. The owner is `owner` (set by default); `friend` is one hop from
 * the owner; `outsider` is not in the graph.
 */
export async function withRelay(
  body: (harness: RelayHarness) => Promise<void>,
  options: {
    owner?: boolean;
    configOverrides?: Partial<Config>;
    onAccepted?: (event: NostrEvent) => void;
  } = {},
): Promise<void> {
  const owner = keyPair();
  const friend = keyPair();
  const outsider = keyPair();
  const store = new FakeEventStore();
  const graph = staticGraph({ [owner.pubkey]: 0, [friend.pubkey]: 1 });
  const config = testConfig({
    owner: options.owner === false ? undefined : owner.pubkey,
    ...options.configOverrides,
  });
  const accepted: NostrEvent[] = [];
  const relay = createRelayServer({
    events: store,
    graph,
    config,
    onAccepted: options.onAccepted ?? ((event) => accepted.push(event)),
  });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (request) => relay.handleUpgrade(request),
  );
  const clients: RelayClient[] = [];
  const harness: RelayHarness = {
    owner,
    friend,
    outsider,
    store,
    config,
    graph,
    accepted,
    relay,
    url: `ws://127.0.0.1:${server.addr.port}/`,
    async connect() {
      const client = await RelayClient.connect(harness.url);
      clients.push(client);
      return client;
    },
  };
  try {
    await body(harness);
  } finally {
    for (const client of clients) await client.close();
    relay.close();
    await server.shutdown();
  }
}
