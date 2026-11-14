/**
 * A {@link TripleStore} on a remote SPARQL 1.1 Protocol endpoint (Oxigraph
 * server, Fuseki, QLever, …). The only thing ever sent to the update URL is
 * `INSERT DATA`.
 *
 * @module
 */
import { encodeBase64 } from "@std/encoding/base64";
import type { StoreConfig, TripleStore } from "../types.ts";
import { type Backend, tripleStore } from "./backend.ts";
import { resultType } from "./sparql_form.ts";

/** Triples per `INSERT DATA` request. */
export const INSERT_BATCH_LINES = 5000;

type EndpointConfig = Extract<StoreConfig, { kind: "sparql" }>;

class EndpointBackend implements Backend {
  readonly #config: EndpointConfig;
  readonly #authorization?: string;

  constructor(config: EndpointConfig) {
    this.#config = config;
    if (config.credentials) {
      this.#authorization = "Basic " +
        encodeBase64(new TextEncoder().encode(config.credentials));
    }
  }

  async #post(
    url: string,
    contentType: string,
    body: string,
    accept: string,
  ): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      Accept: accept,
    };
    if (this.#authorization) headers.Authorization = this.#authorization;
    const response = await fetch(url, { method: "POST", headers, body });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `SPARQL endpoint ${url} answered ${response.status}: ${
          text.slice(0, 300)
        }`,
      );
    }
    return text;
  }

  async insert(ntriples: string): Promise<void> {
    const lines = ntriples.split("\n").filter((line) => line !== "");
    for (let i = 0; i < lines.length; i += INSERT_BATCH_LINES) {
      const batch = lines.slice(i, i + INSERT_BATCH_LINES).join("\n");
      await this.#post(
        this.#config.updateUrl,
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
    return this.#post(
      this.#config.queryUrl,
      "application/sparql-query",
      sparql,
      resultType(form),
    );
  }

  async size(): Promise<number> {
    const body = await this.evaluate(
      "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }",
      "SELECT",
    );
    return Number(JSON.parse(body).results.bindings[0].n.value);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Open a store on the endpoint described by `config`. */
export function openEndpointStore(config: EndpointConfig): TripleStore {
  return tripleStore(new EndpointBackend(config));
}
