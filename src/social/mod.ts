/**
 * The social graph: who is how many follow hops away from the owner.
 * Contract: `docs/ARCHITECTURE.md`.
 * @module
 */
import type { Config, EventStore, SocialGraph } from "../types.ts";

/**
 * Create the social graph. It reads `config.owner` and `config.replication`
 * every time it recomputes, and recomputes by itself when a relevant follow
 * or mute list is stored.
 */
export function createSocialGraph(
  _events: EventStore,
  _config: Config,
): SocialGraph {
  throw new Error("not implemented");
}
