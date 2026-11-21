/**
 * The HTTP side of SPARQL 1.1 Protocol queries, shared by the stores that
 * talk to a remote endpoint.
 *
 * @module
 */
import { QueryLimitError } from "../types.ts";
import { encodeBase64 } from "@std/encoding/base64";
import type { QueryForm } from "./sparql_form.ts";
import { resultType } from "./sparql_form.ts";

/** Options of a {@link SparqlClient}. */
export interface SparqlClientOptions {
  /** `user:password` for HTTP Basic authentication. */
  credentials?: string;
  /** Abort a request that takes longer than this many milliseconds. */
  timeoutMs?: number;
  /**
   * How often to repeat a query that failed for a transient reason (the
   * connection failed, or the answer was 502, 503 or 504), with a pause that
   * doubles from 100 ms. Meant for stores whose endpoint restarts or swaps
   * its index now and then. Default 0.
   */
  retries?: number;
}

/** Overrides for one {@link SparqlClient.evaluate} call. */
export interface EvaluateOptions {
  /**
   * The query comes from outside: give it this time limit instead of the
   * client's, never retry it, and report a timeout as a
   * {@link QueryLimitError}.
   */
  untrustedTimeoutMs?: number;
}

/** Whether `error` is the abort of an `AbortSignal.timeout`. */
function isTimeout(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Posts queries to one endpoint; non-2xx answers become errors. */
export class SparqlClient {
  readonly #queryUrl: string;
  readonly #authorization?: string;
  readonly #timeoutMs?: number;
  readonly #retries: number;

  constructor(queryUrl: string, options: SparqlClientOptions = {}) {
    this.#queryUrl = queryUrl;
    this.#timeoutMs = options.timeoutMs;
    this.#retries = options.retries ?? 0;
    if (options.credentials) {
      this.#authorization = "Basic " +
        encodeBase64(new TextEncoder().encode(options.credentials));
    }
  }

  /** POST `body` to `url`; resolves to the response text. */
  async post(
    url: string,
    contentType: string,
    body: string,
    accept: string,
    timeoutMs: number | undefined = this.#timeoutMs,
  ): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      Accept: accept,
    };
    if (this.#authorization) headers.Authorization = this.#authorization;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(timeoutMs),
    });
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

  /** Evaluate a query; the body is in the media type of `resultType(form)`. */
  async evaluate(
    sparql: string,
    form: QueryForm,
    options: EvaluateOptions = {},
  ): Promise<string> {
    const { untrustedTimeoutMs } = options;
    const retries = untrustedTimeoutMs === undefined ? this.#retries : 0;
    for (let attempt = 0;; attempt++) {
      try {
        return await this.post(
          this.#queryUrl,
          "application/sparql-query",
          sparql,
          resultType(form),
          untrustedTimeoutMs,
        );
      } catch (error) {
        // A query that ran into the time limit would only do so again.
        if (isTimeout(error)) {
          if (untrustedTimeoutMs === undefined) throw error;
          throw new QueryLimitError(
            "timeout",
            `the query took longer than ${untrustedTimeoutMs / 1000} seconds`,
          );
        }
        const transient = !(error instanceof Error) ||
          !/answered (?!50[234]\b)\d+:/.test(error.message);
        if (!transient || attempt >= retries) throw error;
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
  }

  /** The number of triples visible to queries. */
  async size(): Promise<number> {
    const body = await this.evaluate(
      "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }",
      "SELECT",
    );
    return Number(JSON.parse(body).results.bindings[0].n.value);
  }
}
