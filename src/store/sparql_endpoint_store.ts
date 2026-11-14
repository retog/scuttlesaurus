/**
 * A {@link TripleStore} on a remote SPARQL 1.1 Protocol endpoint (Oxigraph
 * server, Fuseki, QLever, …). The only thing ever sent to the update URL is
 * `INSERT DATA`.
 *
 * @module
 */
import type { StoreConfig, TripleStore } from "../types.ts";
import { type Backend, tripleStore } from "./backend.ts";
import { SparqlClient } from "./sparql_client.ts";

/** Triples per `INSERT DATA` request. */
export const INSERT_BATCH_LINES = 5000;

type EndpointConfig = Extract<StoreConfig, { kind: "sparql" }>;

class EndpointBackend implements Backend {
  readonly #client: SparqlClient;
  readonly #updateUrl: string;

  constructor(config: EndpointConfig) {
    this.#client = new SparqlClient(config.queryUrl, {
      credentials: config.credentials,
    });
    this.#updateUrl = config.updateUrl;
  }

  async insert(ntriples: string): Promise<void> {
    const lines = ntriples.split("\n").filter((line) => line !== "");
    for (let i = 0; i < lines.length; i += INSERT_BATCH_LINES) {
      const batch = lines.slice(i, i + INSERT_BATCH_LINES).join("\n");
      await this.#client.post(
        this.#updateUrl,
        "application/sparql-update",
        `INSERT DATA {\n${batch}\n}`,
        "*/*",
      );
    }
  }

  evaluate(
    sparql: string,
    form: Parameters<Backend["evaluate"]>[1],
  ): Promise<string> {
    return this.#client.evaluate(sparql, form);
  }

  size(): Promise<number> {
    return this.#client.size();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Open a store on the endpoint described by `config`. */
export function openEndpointStore(config: EndpointConfig): TripleStore {
  return tripleStore(new EndpointBackend(config));
}
