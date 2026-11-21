/**
 * The public documents of the node: the status (`/api/status`) and the social
 * graph (`/api/graph`). Contract: `docs/ARCHITECTURE.md`, "Node API".
 * @module
 */
import denoJson from "../../deno.json" with { type: "json" };
import type {
  Config,
  EventStore,
  Node,
  ReplicationStatus,
  StoreStats,
} from "../types.ts";
import { externalBase, relayUrlOf } from "../base_url.ts";

/** The document of `GET /api/status`. */
export interface StatusDocument {
  name: string;
  description: string;
  version: string;
  /** Hex public key of the owner, or null before first-run setup. */
  owner: string | null;
  setupRequired: boolean;
  relayUrl: string;
  /** The external base URL the node is reached at. */
  publicUrl: string;
  hops: number;
  publicSparql: boolean;
  blossom: { enabled: boolean; maxBlobSize: number };
  stats: StoreStats;
  /** Number of authors at each distance; index = distance. */
  authorsByHop: number[];
  replication: ReplicationStatus;
  connections: number;
}

/** How long store statistics are reused, in milliseconds. */
const STATS_TTL_MS = 10_000;

/**
 * A function returning the store statistics, computed at most every
 * {@link STATS_TTL_MS}. A failed computation is not kept.
 */
export function cachedStats(
  events: EventStore,
  ttlMs = STATS_TTL_MS,
): () => Promise<StoreStats> {
  let entry: { until: number; value: Promise<StoreStats> } | undefined;
  return () => {
    const now = Date.now();
    if (entry !== undefined && entry.until > now) return entry.value;
    const value = events.stats();
    entry = { until: now + ttlMs, value };
    value.catch(() => {
      if (entry?.value === value) entry = undefined;
    });
    return value;
  };
}

/** The status document, read from the live configuration. */
export async function statusDocument(
  node: Node,
  request: Request,
  stats: () => Promise<StoreStats>,
): Promise<StatusDocument> {
  const config = node.configManager.config;
  const base = externalBase(request, config);
  return {
    name: config.name,
    description: config.description,
    version: denoJson.version,
    owner: config.owner ?? null,
    setupRequired: config.owner === undefined,
    relayUrl: relayUrlOf(base),
    publicUrl: base,
    hops: config.replication.hops,
    publicSparql: config.publicSparql,
    blossom: {
      enabled: config.blossom.enabled,
      maxBlobSize: config.blossom.maxBlobSize,
    },
    stats: await stats(),
    authorsByHop: authorsByHop(node),
    replication: node.replicator.status(),
    connections: node.relay.connections(),
  };
}

/** The social graph document: `{ owner, hops, distances }`. */
export function graphDocument(config: Config, node: Node): unknown {
  return {
    owner: config.owner ?? null,
    hops: config.replication.hops,
    distances: Object.fromEntries(node.graph.authors()),
  };
}

/** Number of authors at each distance from the owner; index = distance. */
function authorsByHop(node: Node): number[] {
  const counts: number[] = [];
  for (const distance of node.graph.authors().values()) {
    counts[distance] = (counts[distance] ?? 0) + 1;
  }
  return Array.from(counts, (count) => count ?? 0);
}
