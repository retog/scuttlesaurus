/**
 * The NIP-01 relay served to clients. Contract: `docs/ARCHITECTURE.md`.
 * @module
 */
import type {
  Config,
  EventStore,
  NostrEvent,
  RelayServer,
  SocialGraph,
} from "../types.ts";

export interface RelayServerOptions {
  events: EventStore;
  graph: SocialGraph;
  config: Config;
  /** Called for every event a client published and the relay accepted. */
  onAccepted?: (event: NostrEvent) => void;
}

export function createRelayServer(_options: RelayServerOptions): RelayServer {
  throw new Error("not implemented");
}
