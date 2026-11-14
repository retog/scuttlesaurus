/**
 * Starts a complete node: configuration, storage, social graph, replication,
 * relay, Blossom and the HTTP server, wired together. Used by `main.ts` and by
 * the tests. Contract: `docs/ARCHITECTURE.md`.
 * @module
 */
import { loadConfig } from "./config.ts";
import { openEventStore, openTripleStore } from "./store/mod.ts";
import { createSocialGraph } from "./social/mod.ts";
import { createReplicator } from "./replication/mod.ts";
import { createRelayServer } from "./relay/mod.ts";
import { createBlossomServer } from "./blossom/mod.ts";
import { createHttpHandler } from "./http/mod.ts";
import type {
  Config,
  ConfigManager,
  EventStore,
  Node,
  NostrEvent,
  Replicator,
  SocialGraph,
} from "./types.ts";

/** A started node: its parts, the address it serves and how to stop it. */
export interface RunningNode {
  node: Node;
  /** The address to open locally, such as `http://127.0.0.1:7777`. */
  url: string;
  /** The port actually bound; differs from the configuration when it is 0. */
  port: number;
  /** Stops the node. Idempotent: later calls return the first call's result. */
  close(): Promise<void>;
}

/**
 * Start a node from the configuration in `env` (defaults to the process
 * environment; see {@link loadConfig}). Resolves once the HTTP server listens
 * and replication has started.
 *
 * @throws If the configuration is invalid or the port cannot be bound. Whatever
 *   was opened before the failure is closed again.
 */
export async function startNode(
  env?: Record<string, string | undefined>,
): Promise<RunningNode> {
  const configManager = await loadConfig(env);
  const config = configManager.config;
  const triples = await openTripleStore(config);
  let events: EventStore;
  try {
    events = await openEventStore(triples, config);
  } catch (error) {
    await triples.close();
    throw error;
  }

  let graph: SocialGraph | undefined;
  let replicator: Replicator | undefined;
  let relay: Node["relay"] | undefined;
  let server: Deno.HttpServer | undefined;
  let reactions: { stop(): Promise<void> } | undefined;
  try {
    graph = createSocialGraph(events, config);
    await graph.recompute();

    replicator = createReplicator(events, graph, config);
    const replicating = replicator;
    relay = createRelayServer({
      events,
      graph,
      config,
      onAccepted: (event) => forward(replicating, config, event),
    });
    const blossom = createBlossomServer({ triples, graph, config });
    const node: Node = {
      configManager,
      events,
      graph,
      replicator,
      relay,
      blossom,
    };

    server = Deno.serve(
      { hostname: config.hostname, port: config.port, onListen() {} },
      createHttpHandler(node),
    );
    reactions = reactToChanges(configManager, graph, replicator);
    replicator.start();

    const parts = { server, reactions, replicator, relay, graph, events };
    const address = server.addr;
    if (address.transport !== "tcp") {
      throw new Error("the node must listen on a TCP port");
    }
    const port = address.port;
    let closing: Promise<void> | undefined;
    return {
      node,
      url: `http://${displayHost(config.hostname)}:${port}`,
      port,
      close: () => (closing ??= shutdown(parts)),
    };
  } catch (error) {
    await shutdown({ server, reactions, replicator, relay, graph, events });
    throw error;
  }
}

/** The parts of a node that exist, in the order they are stopped. */
interface Parts {
  server?: Deno.HttpServer;
  reactions?: { stop(): Promise<void> };
  replicator?: Replicator;
  relay?: Node["relay"];
  graph?: SocialGraph;
  events?: EventStore;
}

/**
 * Stops the parts that exist: no new requests first, then replication, the
 * relay, the social graph and the store. Failures are logged and do not stop
 * the rest.
 */
async function shutdown(parts: Parts): Promise<void> {
  const steps: Array<[string, () => unknown]> = [
    ["http server", () => parts.server?.shutdown()],
    ["configuration listener", () => parts.reactions?.stop()],
    ["replicator", () => parts.replicator?.stop()],
    ["relay", () => parts.relay?.close()],
    ["social graph", () => parts.graph?.close()],
    ["event store", () => parts.events?.close()],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      console.error(`shutdown: closing the ${name} failed`, error);
    }
  }
}

/**
 * Forwards an event the relay accepted to the author's write relays, as
 * `replication.forward` allows. Not awaited; failures are logged.
 */
function forward(
  replicator: Replicator,
  config: Config,
  event: NostrEvent,
): void {
  const policy = config.replication.forward;
  const wanted = policy === "all" ||
    (policy === "owner" && event.pubkey === config.owner);
  if (!wanted) return;
  Promise.resolve()
    .then(() => replicator.publish(event))
    .then((results) => {
      // An event nobody took exists on this node only; say so.
      if (results.length > 0 && !results.some((result) => result.ok)) {
        const tried = results
          .map((result) => `${result.relay} (${result.message ?? "no answer"})`)
          .join(", ");
        console.warn(
          `replication: event ${event.id} was accepted by none of its author's relays: ${tried}`,
        );
      }
    })
    .catch((error) => console.error("replication: publish failed", error));
}

/**
 * Restarts replication whenever the configuration changes, after the social
 * graph is recomputed. Reactions run one after another, so two quick changes
 * cannot interleave. `stop` stops listening and waits for a running reaction.
 */
function reactToChanges(
  configManager: ConfigManager,
  graph: SocialGraph,
  replicator: Replicator,
): { stop(): Promise<void> } {
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  const unsubscribe = configManager.onChange(() => {
    queue = queue.then(async () => {
      if (stopped) return;
      try {
        await graph.recompute();
        await replicator.stop();
        replicator.start();
      } catch (error) {
        console.error(
          "replication restart after a configuration change failed",
          error,
        );
      }
    });
  });
  return {
    async stop() {
      stopped = true;
      unsubscribe();
      await queue;
    },
  };
}

/** The host to show in a URL: wildcard addresses become loopback. */
function displayHost(hostname: string): string {
  if (hostname === "0.0.0.0" || hostname === "") return "127.0.0.1";
  if (hostname === "::") return "[::1]";
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}
