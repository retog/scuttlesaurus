/**
 * Scuttlesaurus entry point: loads the configuration, instantiates every
 * module and serves them on one port. See `docs/ARCHITECTURE.md`.
 * @module
 */
import { loadConfig } from "./src/config.ts";
import { openEventStore, openTripleStore } from "./src/store/mod.ts";
import { createSocialGraph } from "./src/social/mod.ts";
import { createReplicator } from "./src/replication/mod.ts";
import { createRelayServer } from "./src/relay/mod.ts";
import { createBlossomServer } from "./src/blossom/mod.ts";
import { createHttpHandler } from "./src/http/mod.ts";

if (import.meta.main) {
  const configManager = await loadConfig();
  const config = configManager.config;
  const triples = await openTripleStore(config);
  const events = await openEventStore(triples, config);
  const graph = createSocialGraph(events, config);
  const replicator = createReplicator(events, graph, config);
  const relay = createRelayServer({ events, graph, config });
  const blossom = createBlossomServer({ triples, graph, config });
  const handler = createHttpHandler({
    configManager,
    events,
    graph,
    replicator,
    relay,
    blossom,
  });
  Deno.serve({ hostname: config.hostname, port: config.port }, handler);
}
