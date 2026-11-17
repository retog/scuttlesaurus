/**
 * What the two triple store implementations have in common: they only supply
 * raw operations, and {@link tripleStore} derives the typed
 * {@link TripleStore} (SELECT/ASK parsing, query form checks) from them.
 *
 * @module
 */
import type { QueryOptions, SparqlBinding, TripleStore } from "../types.ts";
import { queryForm, resultType } from "./sparql_form.ts";

/** The operations a storage engine must provide. */
export interface Backend {
  insert(ntriples: string): Promise<void>;
  /** Evaluate a query; `body` is in the media type of `resultType(form)`. */
  evaluate(
    sparql: string,
    form: ReturnType<typeof queryForm>,
    options?: QueryOptions,
  ): Promise<string>;
  size(): Promise<number>;
  close(): Promise<void>;
}

/** Build a {@link TripleStore} on a {@link Backend}. */
export function tripleStore(backend: Backend): TripleStore {
  const run = async (sparql: string, options?: QueryOptions) => {
    const form = queryForm(sparql);
    const body = await backend.evaluate(sparql, form, options);
    return { form, contentType: resultType(form), body };
  };
  return {
    insert: (ntriples) =>
      ntriples === "" ? Promise.resolve() : backend.insert(ntriples),
    async select(sparql) {
      const { form, body } = await run(sparql);
      if (form !== "SELECT") throw new Error("Not a SELECT query");
      return JSON.parse(body).results.bindings as SparqlBinding[];
    },
    async ask(sparql) {
      const { form, body } = await run(sparql);
      if (form !== "ASK") throw new Error("Not an ASK query");
      return JSON.parse(body).boolean === true;
    },
    async query(sparql, options) {
      const { contentType, body } = await run(sparql, options);
      return { contentType, body };
    },
    size: () => backend.size(),
    close: () => backend.close(),
  };
}
