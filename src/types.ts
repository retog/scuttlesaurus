/**
 * The contracts between the modules of Scuttlesaurus.
 *
 * Every module depends on these interfaces only, never on another module's
 * implementation. `main.ts` is the one place where implementations are
 * instantiated and handed to each other. See `docs/ARCHITECTURE.md`.
 *
 * @module
 */
import type { Event } from "@nostr/tools/core";
import type { Filter } from "@nostr/tools/filter";

/** A signed Nostr event (NIP-01). */
export type NostrEvent = Event;
export type { Filter };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Where the graph is kept. */
export type StoreConfig =
  /** Oxigraph embedded in the process, persisted as an append-only log. */
  | { kind: "embedded" }
  /** Any SPARQL 1.1 Protocol endpoint (Oxigraph server, Fuseki, QLever, …). */
  | {
    kind: "sparql";
    queryUrl: string;
    updateUrl: string;
    /** `user:password` for HTTP Basic authentication. */
    credentials?: string;
  }
  /**
   * A directory of N-Triples files indexed by qlever-dir: batches are written
   * as files and queried through qlever-dir's read-only endpoint.
   */
  | {
    kind: "qlever-dir";
    /** qlever-dir's SPARQL endpoint. */
    queryUrl: string;
    /** The directory Scuttlesaurus writes to and qlever-dir watches. */
    graphDir: string;
    /**
     * qlever-dir's `BASE_URI` plus the path of `graphDir` inside its `/data`;
     * ends with `/`. Graph IRIs are this followed by a file's relative path.
     */
    baseUri: string;
  };

export interface ReplicationConfig {
  /** Set to false to never open outgoing relay connections. */
  enabled: boolean;
  /** Maximum social distance, in follow hops from the owner, to replicate. */
  hops: number;
  /** Upper bound on the number of authors replicated, across all hops. */
  maxAuthors: number;
  /**
   * How many days of regular events to fetch, indexed by hop distance. The
   * last entry applies to all further hops. `0` means unlimited.
   */
  horizonDays: number[];
  /** Relays used to discover profiles and relay lists, and as fallback. */
  bootstrapRelays: string[];
  /** Maximum number of simultaneous outgoing relay connections. */
  maxRelays: number;
  /**
   * Whose events, when published to this node's relay by a client, are
   * forwarded to the author's write relays.
   */
  forward: "none" | "owner" | "all";
  /**
   * Whether relays named in *other people's* relay lists (NIP-65) may use
   * unencrypted `ws://` or point at loopback, private, link-local or otherwise
   * non-public hosts. Off by default because a relay list is data from
   * strangers: allowing it lets any followed author make this server connect
   * to its internal network. Relays the owner configured as bootstrap relays
   * are always allowed.
   */
  allowPrivateRelays: boolean;
}

export interface BlossomConfig {
  enabled: boolean;
  /** Largest accepted upload in bytes. */
  maxBlobSize: number;
}

/**
 * The effective configuration: defaults, overlaid by `<dataDir>/config.json`,
 * overlaid by environment variables. The object is long-lived and mutated in
 * place when settings change; see {@link ConfigManager}.
 */
export interface Config {
  /** Hex public key of the node's owner. Undefined until first-run setup. */
  owner?: string;
  hostname: string;
  port: number;
  /** Directory holding the graph log, blobs, config.json and sync state. */
  dataDir: string;
  /** Externally visible base URL such as `https://saurus.example.org`. */
  publicUrl?: string;
  /** Relay name and description for the NIP-11 document and the UI. */
  name: string;
  description: string;
  replication: ReplicationConfig;
  store: StoreConfig;
  blossom: BlossomConfig;
  /** Whether `/sparql` is open to everyone (the web client needs it). */
  publicSparql: boolean;
  /**
   * Longest time, in milliseconds, an untrusted query (one that came in over
   * `/sparql`) may run before the store gives up on it.
   */
  sparqlTimeoutMs: number;
  /**
   * Whether kind 24133 events (NIP-46 Nostr Connect) are relayed for any
   * author. Off: they get the normal write policy.
   */
  nostrConnect: boolean;
  /** Largest number of events returned for a single filter. */
  maxLimit: number;
}

/** The settings that can be changed at runtime through the API. */
export type ConfigPatch = {
  owner?: string;
  name?: string;
  description?: string;
  publicUrl?: string;
  replication?: Partial<ReplicationConfig>;
};

export interface ConfigManager {
  /** The live configuration object. */
  readonly config: Config;
  /**
   * The settings fixed by environment variables, which {@link update} refuses
   * to change, as dotted paths such as `owner` or `replication.hops`.
   */
  readonly locked: ReadonlySet<string>;
  /** Apply, persist to `config.json` and notify listeners. */
  update(patch: ConfigPatch): Promise<void>;
  /** Returns a function that removes the listener. */
  onChange(listener: (config: Config) => void): () => void;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** One term of a SPARQL 1.1 Query Results JSON binding. */
export interface SparqlTerm {
  type: "uri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  "xml:lang"?: string;
}

export type SparqlBinding = Record<string, SparqlTerm>;

/** How a query is to be treated; see {@link TripleStore.query}. */
export interface QueryOptions {
  /** The query text comes from outside (a `/sparql` request). */
  untrusted?: boolean;
}

/**
 * An untrusted query was not answered because of a resource limit, not
 * because it is wrong: `timeout` when it ran longer than the configured time
 * limit, `busy` when the store has no capacity for it now (a replica is being
 * rebuilt, or too many queries are waiting) and it may be tried again.
 */
export class QueryLimitError extends Error {
  constructor(
    readonly reason: "timeout" | "busy",
    message: string,
    /** For `busy`: seconds after which a retry is sensible. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "QueryLimitError";
  }
}

/**
 * A monotonically growing RDF graph. There is deliberately no operation that
 * removes or changes a triple: `insert` is the only way to write.
 */
export interface TripleStore {
  /** Add the triples of an N-Triples document. Idempotent per triple. */
  insert(ntriples: string): Promise<void>;
  /** Evaluate a SPARQL SELECT query. */
  select(sparql: string): Promise<SparqlBinding[]>;
  /** Evaluate a SPARQL ASK query. */
  ask(sparql: string): Promise<boolean>;
  /**
   * Evaluate any SPARQL *query* (never an update) and return the serialized
   * result: `application/sparql-results+json` for SELECT and ASK,
   * `application/n-triples` for CONSTRUCT and DESCRIBE. Backs `/sparql`.
   *
   * With `options.untrusted` the query text comes from outside and must not
   * be able to stall the node: the store bounds its run time and keeps it
   * away from inserts and internal queries.
   *
   * @throws {QueryLimitError} when an untrusted query ran out of time, or the
   *   store has no capacity for it right now.
   */
  query(
    sparql: string,
    options?: QueryOptions,
  ): Promise<{ contentType: string; body: string }>;
  /** Number of triples in the graph. */
  size(): Promise<number>;
  close(): Promise<void>;
}

/** Outcome of offering an event to the store. */
export type AddResult =
  /** The event is new and is now part of the graph. */
  | { status: "stored" }
  /** The event was already in the graph. */
  | { status: "duplicate" }
  /** A valid ephemeral event (kinds 20000–29999): announced, not stored. */
  | { status: "ephemeral" }
  /** Invalid, retracted by its author, or otherwise unacceptable. */
  | { status: "rejected"; reason: string };

export interface AddOptions {
  /** URL of the relay the event was received from, recorded as provenance. */
  seenOn?: string;
  /** The signature has already been verified by the caller. */
  verified?: boolean;
}

export interface EventListenerInfo {
  seenOn?: string;
  /** False for ephemeral events. */
  stored: boolean;
}

export interface StoreStats {
  events: number;
  triples: number;
  authors: number;
}

/** Nostr events on top of a {@link TripleStore}. */
export interface EventStore {
  /** The underlying graph. */
  readonly triples: TripleStore;
  /**
   * Validate and store an event, maintaining the `supersededBy` and
   * `deletedBy` bookkeeping. Calls are serialized internally.
   */
  add(event: NostrEvent, options?: AddOptions): Promise<AddResult>;
  /** Whether an event id is in the graph. Synchronous and cheap. */
  has(id: string): boolean;
  /**
   * Events matching any of the filters, with NIP-01 semantics: per filter
   * newest first and capped by `limit`; superseded and retracted events are
   * never returned. The union is deduplicated and sorted newest first.
   */
  query(filters: Filter[]): Promise<NostrEvent[]>;
  /** Number of events {@link query} would return without `limit` (NIP-45). */
  count(filters: Filter[]): Promise<number>;
  /** Current follow list (NIP-02) of each given pubkey that has one. */
  follows(pubkeys: string[]): Promise<Map<string, string[]>>;
  /** Current public mute list (NIP-51, kind 10000) of a pubkey. */
  mutes(pubkey: string): Promise<string[]>;
  /** Current relay list (NIP-65) of each given pubkey that has one. */
  relayLists(
    pubkeys: string[],
  ): Promise<Map<string, { read: string[]; write: string[] }>>;
  /**
   * For the given authors, how many of their events were first received from
   * which relay: `Map<pubkey, Map<relayUrl, count>>`. Derived from `seenOn`.
   */
  relayScores(pubkeys: string[]): Promise<Map<string, Map<string, number>>>;
  /**
   * Be told about every event accepted from now on (stored or ephemeral).
   * Returns a function that removes the listener.
   */
  subscribe(
    listener: (event: NostrEvent, info: EventListenerInfo) => void,
  ): () => void;
  stats(): Promise<StoreStats>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Social graph
// ---------------------------------------------------------------------------

/**
 * The owner's follow graph, which decides whose events this node replicates,
 * accepts and hosts blobs for.
 */
export interface SocialGraph {
  /** Hops from the owner (0 = the owner); undefined when out of range. */
  distance(pubkey: string): number | undefined;
  /** All authors in range with their distance. */
  authors(): ReadonlyMap<string, number>;
  /** Recompute from the store; resolves when done. */
  recompute(): Promise<void>;
  /** Called after a recomputation changed the set of authors or a distance. */
  onChange(listener: () => void): () => void;
  /** Stop listening to the store. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Replication
// ---------------------------------------------------------------------------

export interface RelayStatus {
  url: string;
  state: "connecting" | "connected" | "backoff" | "closed";
  /** Number of authors this relay is asked for. */
  authors: number;
  /** New events (not duplicates) received from this relay since start. */
  eventsReceived: number;
  /** Whether historic events are still being fetched. */
  backfilling: boolean;
  lastError?: string;
}

export interface ReplicationStatus {
  enabled: boolean;
  running: boolean;
  /** Number of authors at each hop distance; index = distance. */
  authorsByHop: number[];
  relays: RelayStatus[];
}

export interface PublishResult {
  relay: string;
  ok: boolean;
  message?: string;
}

/** Proactively pulls the events of the social graph and pushes local ones. */
export interface Replicator {
  start(): void;
  stop(): Promise<void>;
  status(): ReplicationStatus;
  /** Send an event to its author's write relays (or the bootstrap relays). */
  publish(event: NostrEvent): Promise<PublishResult[]>;
}

// ---------------------------------------------------------------------------
// Network-facing services
// ---------------------------------------------------------------------------

/** The NIP-01 relay that clients, including the web client, connect to. */
export interface RelayServer {
  /** Upgrade a WebSocket request and serve the relay protocol on it. */
  handleUpgrade(request: Request): Response;
  /** The NIP-11 relay information document. */
  info(request: Request): Response;
  /** Number of open client connections. */
  connections(): number;
  close(): void;
}

/** The Blossom blob server (BUD-01, BUD-02). */
export interface BlossomServer {
  /**
   * Answer the request if it is a Blossom request, otherwise return null so
   * the HTTP server can try the next handler.
   */
  handle(request: Request): Promise<Response | null>;
}

/** Everything `main.ts` wires together; handed to the HTTP layer. */
export interface Node {
  configManager: ConfigManager;
  events: EventStore;
  graph: SocialGraph;
  replicator: Replicator;
  relay: RelayServer;
  blossom: BlossomServer;
}
