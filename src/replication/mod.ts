/**
 * Proactive, social-distance based replication over outgoing relay
 * connections. Contract: `docs/ARCHITECTURE.md`.
 * @module
 */
import type { Config, EventStore, Replicator, SocialGraph } from "../types.ts";

export function createReplicator(
  _events: EventStore,
  _graph: SocialGraph,
  _config: Config,
): Replicator {
  throw new Error("not implemented");
}
