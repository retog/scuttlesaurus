/**
 * Proactive, social-distance based replication over outgoing relay
 * connections (NIP-01), choosing relays by the outbox model (NIP-65).
 * Contract: `docs/ARCHITECTURE.md`.
 * @module
 */
import type { Config, EventStore, Replicator, SocialGraph } from "../types.ts";
import type { ReplicatorOptions } from "./options.ts";
import { NodeReplicator } from "./replicator.ts";

export type { ReplicatorOptions } from "./options.ts";
export { planRelays } from "./plan.ts";
export type { PlanInput, PlannedRelay } from "./plan.ts";

/**
 * Create the replicator. Nothing connects until `start()`; `start()` does
 * nothing while `config.replication.enabled` is false or the node has no
 * owner. The configuration is read when a plan is made, so changes take effect
 * on the next `stop()`/`start()`.
 *
 * @param events Where received events go, and where relay lists come from.
 * @param graph Whose events to replicate, and at what distance.
 * @param config The live configuration.
 * @param options Tuning for tests; `main.ts` passes none.
 */
export function createReplicator(
  events: EventStore,
  graph: SocialGraph,
  config: Config,
  options?: ReplicatorOptions,
): Replicator {
  return new NodeReplicator(events, graph, config, options);
}
