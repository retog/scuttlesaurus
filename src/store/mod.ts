/**
 * The storage layer: a monotonically growing RDF graph and the Nostr event
 * store on top of it. Contract: `docs/ARCHITECTURE.md`, `docs/DATA-MODEL.md`.
 * @module
 */
import type { Config, EventStore, TripleStore } from "../types.ts";

/** Open the triple store selected by `config.store`. */
export function openTripleStore(_config: Config): Promise<TripleStore> {
  throw new Error("not implemented");
}

/** Open the event store on top of a triple store. */
export function openEventStore(
  _triples: TripleStore,
  _config: Config,
): Promise<EventStore> {
  throw new Error("not implemented");
}
