/**
 * SPARQL access to the node: `select()` plus helpers that build queries
 * safely. Never concatenate user input into a query without going through
 * {@link str}, {@link iriRef}, {@link int} or {@link values}.
 *
 * @module
 */
import { PREFIXES } from "../../../src/vocab.ts";
import { addressIri, eventIri, pubkeyIri } from "../../../src/vocab.ts";
import { getAuthorization } from "./auth.ts";

export { PREFIXES };

/** One result row: variable name → lexical value (unbound → undefined). */
export type Row = Record<string, string | undefined>;

/** Error of a failed query, with the HTTP status when there was one. */
export class SparqlError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SparqlError";
  }
}

/** Pauses before asking a busy node again; then the error is shown. */
const BUSY_WAITS_MS = [500, 1500, 4000];

interface JsonResults {
  head?: { vars?: string[] };
  results?: {
    bindings: Record<string, { type: string; value: string }>[];
  };
}

async function post(query: string, authorized: boolean): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/sparql-query",
    accept: "application/sparql-results+json",
  };
  if (authorized) {
    const auth = await getAuthorization("/sparql", "POST", query);
    if (auth) headers.authorization = auth;
  }
  return fetch("/sparql", { method: "POST", headers, body: query });
}

/**
 * Run a SELECT query and flatten the bindings to plain objects. The prefixes
 * `nostr:`, `tag:` and `xsd:` are declared for you. When the node requires
 * authorization for `/sparql` and the session can sign, the request is
 * retried with NIP-98.
 */
export async function select(query: string): Promise<Row[]> {
  const text = /^\s*PREFIX\s/i.test(query) ? query : PREFIXES + query;
  let response: Response;
  try {
    for (let attempt = 0;; attempt++) {
      response = await post(text, false);
      if (response.status === 401 || response.status === 403) {
        response = await post(text, true);
      }
      // 503 with Retry-After: the node is busy (its query replica is starting
      // or its queue is full), which passes. Without the header the query
      // itself took too long, and asking again would not help.
      const wait = BUSY_WAITS_MS[attempt];
      if (
        response.status !== 503 || !response.headers.has("retry-after") ||
        wait === undefined
      ) break;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  } catch (error) {
    throw new SparqlError(`Node unreachable: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    if (response.status === 503) {
      // The node's query limit: busy, or the query took too long.
      throw new SparqlError(
        `The node could not answer the query: ${detail || "it is busy"}`,
        response.status,
      );
    }
    throw new SparqlError(
      `SPARQL ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  let json: JsonResults;
  try {
    json = await response.json();
  } catch {
    throw new SparqlError("SPARQL endpoint did not return JSON");
  }
  return (json.results?.bindings ?? []).map((binding) => {
    const row: Row = {};
    for (const [name, term] of Object.entries(binding)) row[name] = term.value;
    return row;
  });
}

// --- Term builders ---------------------------------------------------------------

/** An IRI reference `<…>`; throws when the IRI contains forbidden characters. */
export function iriRef(iri: string): string {
  if (/[<>"{}|^`\\\s]/.test(iri) || [...iri].some((c) => c < "!")) {
    throw new Error(`Unsafe IRI: ${iri}`);
  }
  return `<${iri}>`;
}

/** A string literal with correct SPARQL escaping. */
export function str(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else out += char;
  }
  return `"${out}"`;
}

/** An integer literal. Throws on NaN/Infinity; fractions are truncated. */
export function int(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Not an integer: ${n}`);
  return String(Math.trunc(n));
}

/** `VALUES ?varName { term term … }` (terms must already be valid terms). */
export function values(varName: string, terms: readonly string[]): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
    throw new Error(`Bad variable name: ${varName}`);
  }
  return `VALUES ?${varName} { ${terms.join(" ")} }`;
}

/** Term for a hex pubkey: `<nostr:npub1…>`. */
export function pubkeyTerm(pubkey: string): string {
  return iriRef(pubkeyIri(pubkey));
}

/** Term for a hex event id: `<nostr:note1…>`. */
export function eventTerm(id: string): string {
  return iriRef(eventIri(id));
}

/** Term for an article coordinate: `<nostr:naddr1…>` (no relay hints). */
export function addressTerm(
  kind: number,
  pubkey: string,
  identifier: string,
): string {
  return iriRef(addressIri(kind, pubkey, identifier));
}

/**
 * `xsd:date` terms for the `days` UTC days ending at `until` (newest first),
 * for the `nostr:date` window idiom:
 * `values("date", recentDates(3))` →
 * `VALUES ?date { "2026-11-13"^^xsd:date … }`.
 */
export function recentDates(days: number, until: Date = new Date()): string[] {
  const out: string[] = [];
  const start = Date.UTC(
    until.getUTCFullYear(),
    until.getUTCMonth(),
    until.getUTCDate(),
  );
  for (let i = 0; i < days; i++) {
    const day = new Date(start - i * 86_400_000).toISOString().slice(0, 10);
    out.push(`"${day}"^^xsd:date`);
  }
  return out;
}

// --- Universal exclusions ---------------------------------------------------------

/*
 * Exclusions are written as `MINUS { … }`, not `FILTER NOT EXISTS { … }`. The
 * two give the same rows when the subtracted pattern shares a variable with
 * what comes before it and holds no filter, which is the case for all of
 * these. QLever answers a query with several `FILTER NOT EXISTS` slowly (the
 * key query of the home feed took 7 s on a graph of 1.9 million triples, and
 * runs into QLever's 30 s planning limit on a node with unmerged updates) and
 * the same query with `MINUS` in 0.15 s. Oxigraph needs about the same for
 * both.
 *
 * `MINUS` subtracts from what precedes it in the group, so put these helpers
 * after the patterns that bind the variable, and give the variables used only
 * inside a unique name.
 */

/**
 * Exclude retracted events (NIP-09): every query needs this. Emits a `MINUS`,
 * so `variable` must already be bound by an earlier pattern of the group.
 */
export function notDeleted(variable: string): string {
  return `MINUS { ${variable} nostr:deletedBy ?_del${variable.slice(1)} }`;
}

/**
 * Keep only the current version of a replaceable or addressable event
 * (kinds 0, 3, 10000–19999, 30000–39999). Emits a `MINUS`, so `variable` must
 * already be bound by an earlier pattern of the group.
 */
export function notSuperseded(variable: string): string {
  return `MINUS { ${variable} nostr:supersededBy ?_new${variable.slice(1)} }`;
}
