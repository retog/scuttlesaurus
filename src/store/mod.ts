/**
 * The storage layer: a monotonically growing RDF graph and the Nostr event
 * store on top of it. Contract: `docs/ARCHITECTURE.md`, `docs/DATA-MODEL.md`.
 * @module
 */
import type { Config, EventStore, TripleStore } from "../types.ts";
import { openEmbeddedStore } from "./embedded_store.ts";
import { createEventStore } from "./event_store.ts";
import { openEndpointStore } from "./sparql_endpoint_store.ts";

export { eventToTriples } from "./event_triples.ts";
export { iri, literal } from "./ntriples.ts";

/** Open the triple store selected by `config.store`. */
export function openTripleStore(config: Config): Promise<TripleStore> {
  return config.store.kind === "embedded"
    ? openEmbeddedStore(config.dataDir)
    : Promise.resolve(openEndpointStore(config.store));
}

/**
 * Open the event store on top of a triple store. Closing it closes `triples`.
 */
export function openEventStore(
  triples: TripleStore,
  config: Config,
): Promise<EventStore> {
  return createEventStore(triples, config);
}
