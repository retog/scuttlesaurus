/**
 * The social graph: who is how many follow hops (NIP-02) from the owner,
 * minus the owner's mute list (NIP-51). Contract: `docs/ARCHITECTURE.md`.
 * @module
 */
import type { Config, EventStore, SocialGraph } from "../types.ts";
import { type SocialGraphOptions, StoreSocialGraph } from "./graph.ts";

export type { SocialGraphOptions } from "./graph.ts";

/**
 * Create the social graph. It reads `config.owner` and `config.replication`
 * every time it recomputes, and recomputes by itself, debounced, when a follow
 * list (NIP-02) of an author within reach or the owner's mute list (NIP-51) is
 * stored. It starts empty: call `recompute()` to fill it.
 *
 * @param events The store that holds the follow and mute lists.
 * @param config The live configuration; mutated when settings change.
 * @param options Tuning for tests; `main.ts` passes none.
 */
export function createSocialGraph(
  events: EventStore,
  config: Config,
  options?: SocialGraphOptions,
): SocialGraph {
  return new StoreSocialGraph(events, config, options);
}
