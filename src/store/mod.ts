/**
 * The storage layer: a monotonically growing RDF graph and the Nostr event
 * store on top of it. Contract: `docs/ARCHITECTURE.md`, `docs/DATA-MODEL.md`.
 * @module
 */
import { join } from "@std/path";
import type { Config, EventStore, TripleStore } from "../types.ts";
import { openEmbeddedStore } from "./embedded_store.ts";
import { createEventStore, type GroupOptions } from "./event_store.ts";
import { openQleverDirStore } from "./qlever_dir_store.ts";
import { openEndpointStore } from "./sparql_endpoint_store.ts";

export { eventToTriples } from "./event_triples.ts";
export { iri, literal } from "./ntriples.ts";

/** Open the triple store selected by `config.store`. */
export function openTripleStore(config: Config): Promise<TripleStore> {
  const store = config.store;
  switch (store.kind) {
    case "embedded":
      return openEmbeddedStore(config.dataDir, {
        untrustedTimeoutMs: config.sparqlTimeoutMs,
        workers: config.sparqlWorkers,
      });
    case "sparql":
      return Promise.resolve(openEndpointStore(store, {
        untrustedTimeoutMs: config.sparqlTimeoutMs,
      }));
    case "qlever-dir":
      return openQleverDirStore(store, {
        stateFile: join(config.dataDir, "qlever-dir-state.json"),
        untrustedTimeoutMs: config.sparqlTimeoutMs,
      });
  }
}

/**
 * Open the event store on top of a triple store. Closing it closes `triples`.
 * Adds are committed in groups; `group` tunes their size.
 */
export function openEventStore(
  triples: TripleStore,
  config: Config,
  group?: GroupOptions,
): Promise<EventStore> {
  return createEventStore(triples, config, group);
}

export type { GroupOptions } from "./event_store.ts";
