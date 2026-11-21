/**
 * A {@link TripleStore} on a remote SPARQL 1.1 Protocol endpoint (Oxigraph
 * server, Fuseki, QLever, …). The only thing ever sent to the update URL is
 * `INSERT DATA`.
 *
 * @module
 */
import type { QueryOptions, StoreConfig, TripleStore } from "../types.ts";
import { type Backend, tripleStore } from "./backend.ts";
import { SparqlClient } from "./sparql_client.ts";

/** Triples per `INSERT DATA` request. */
export const INSERT_BATCH_LINES = 5000;

type EndpointConfig = Extract<StoreConfig, { kind: "sparql" }>;

class EndpointBackend implements Backend {
  readonly #client: SparqlClient;
  readonly #updateUrl: string;

  readonly #untrustedTimeoutMs: number | undefined;

  constructor(config: EndpointConfig, options: EndpointOptions) {
    this.#untrustedTimeoutMs = options.untrustedTimeoutMs;
    this.#client = new SparqlClient(config.queryUrl, {
      credentials: config.credentials,
    });
    this.#updateUrl = config.updateUrl;
  }

  async insert(ntriples: string): Promise<void> {
    // The requests are not atomic together: if one fails, the earlier ones
    // stay. The group commit orders its document so that what is left is
    // repairable (complete events, then the bookkeeping, see `planGroup`), so
    // the lines must be sent in the order given.
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
    options?: QueryOptions,
  ): Promise<string> {
    return this.#client.evaluate(sparql, form, {
      untrustedTimeoutMs: options?.untrusted
        ? this.#untrustedTimeoutMs
        : undefined,
    });
  }

  size(): Promise<number> {
    return this.#client.size();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Options of the endpoint store. */
export interface EndpointOptions {
  /** Time limit of queries that came from outside; none when unset. */
  untrustedTimeoutMs?: number;
}

/** Open a store on the endpoint described by `config`. */
export function openEndpointStore(
  config: EndpointConfig,
  options: EndpointOptions = {},
): TripleStore {
  return tripleStore(new EndpointBackend(config, options));
}
