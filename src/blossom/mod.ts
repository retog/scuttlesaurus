/**
 * The Blossom blob server. Contract: `docs/ARCHITECTURE.md`.
 * @module
 */
import type {
  BlossomServer,
  Config,
  SocialGraph,
  TripleStore,
} from "../types.ts";

export interface BlossomServerOptions {
  triples: TripleStore;
  graph: SocialGraph;
  config: Config;
}

export function createBlossomServer(
  _options: BlossomServerOptions,
): BlossomServer {
  throw new Error("not implemented");
}
