/**
 * Scuttlesaurus entry point: starts the node, prints where it is and shuts it
 * down on SIGINT or SIGTERM. See `docs/ARCHITECTURE.md`.
 * @module
 */
import * as nip19 from "@nostr/tools/nip19";
import type { Config } from "./src/types.ts";
import { type RunningNode, startNode } from "./src/node.ts";

if (import.meta.main) {
  let running: RunningNode;
  try {
    running = await startNode();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }

  printBanner(running);

  const stop = async () => {
    try {
      await running.close();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      Deno.exit(1);
    }
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
}

/** The start-up message: where the node is, who owns it, and how it stores. */
function printBanner(running: RunningNode): void {
  const config: Config = running.node.configManager.config;
  const owner = config.owner === undefined
    ? "none yet: the first visitor sets up the node"
    : nip19.npubEncode(config.owner);
  const store = config.store.kind === "embedded"
    ? `embedded graph in ${config.dataDir}`
    : `SPARQL endpoint ${config.store.queryUrl}`;
  const lines = [
    "Scuttlesaurus is running.",
    `  open:        ${running.url}/`,
    ...(config.publicUrl === undefined
      ? []
      : [`  public:      ${config.publicUrl}`]),
    `  owner:       ${owner}`,
    `  store:       ${store}`,
    `  data:        ${config.dataDir}`,
    `  hops:        ${config.replication.hops}`,
    `  replication: ${config.replication.enabled ? "on" : "off"}`,
  ];
  console.log(lines.join("\n"));
}
