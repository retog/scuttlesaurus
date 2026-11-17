/**
 * Helpers for tests: an in-process {@link TripleStore}, a fixed
 * {@link SocialGraph} and a complete {@link Config}. Not used at runtime.
 * @module
 */
import oxigraph from "oxigraph";
import { queryForm, resultType } from "../store/sparql_form.ts";
import type {
  Config,
  SocialGraph,
  SparqlBinding,
  TripleStore,
} from "../types.ts";

/** A {@link TripleStore} backed by Oxigraph in the calling thread. */
export class MemoryTripleStore implements TripleStore {
  readonly #store = new oxigraph.Store();

  insert(ntriples: string): Promise<void> {
    this.#store.load(ntriples, { format: "application/n-triples" });
    return Promise.resolve();
  }

  select(sparql: string): Promise<SparqlBinding[]> {
    const json = this.#store.query(sparql, {
      results_format: "application/sparql-results+json",
    }) as string;
    return Promise.resolve(JSON.parse(json).results.bindings);
  }

  ask(sparql: string): Promise<boolean> {
    return Promise.resolve(this.#store.query(sparql) as boolean);
  }

  query(sparql: string): Promise<{ contentType: string; body: string }> {
    const contentType = resultType(queryForm(sparql));
    const body = this.#store.query(sparql, {
      results_format: contentType,
    }) as string;
    return Promise.resolve({ contentType, body });
  }

  size(): Promise<number> {
    return Promise.resolve(this.#store.size);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A {@link SocialGraph} with fixed distances, keyed by hex public key. */
export function staticGraph(distances: Record<string, number>): SocialGraph {
  const map = new Map(Object.entries(distances));
  return {
    distance: (pubkey) => map.get(pubkey),
    authors: () => map,
    recompute: () => Promise.resolve(),
    onChange: () => () => {},
    close: () => {},
  };
}

/** A complete configuration with the documented defaults, for tests. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    hostname: "127.0.0.1",
    port: 0,
    dataDir: "./data",
    name: "Scuttlesaurus",
    description: "A test node",
    replication: {
      enabled: false,
      hops: 2,
      maxAuthors: 1500,
      horizonDays: [0, 90, 14],
      bootstrapRelays: [],
      maxRelays: 12,
      forward: "all",
      allowPrivateRelays: false,
    },
    store: { kind: "embedded" },
    blossom: { enabled: true, maxBlobSize: 50 * 1024 * 1024 },
    publicSparql: true,
    sparqlTimeoutMs: 10_000,
    nostrConnect: true,
    maxLimit: 500,
    ...overrides,
  };
}
