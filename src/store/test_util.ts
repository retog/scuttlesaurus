/**
 * Helpers shared by the tests of this directory: signed events, parsing of
 * N-Triples output and an event store on the in-process triple store.
 *
 * @module
 */
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "@nostr/tools/pure";
import { MemoryTripleStore, testConfig } from "../testing/mod.ts";
import type {
  Config,
  EventStore,
  NostrEvent,
  QueryOptions,
  SparqlBinding,
  TripleStore,
} from "../types.ts";
import { createEventStore } from "./event_store.ts";

/** A key pair for signing test events. */
export interface Identity {
  secret: Uint8Array;
  pubkey: string;
}

/** Create `count` fresh identities. */
export function identities(count: number): Identity[] {
  return Array.from({ length: count }, () => {
    const secret = generateSecretKey();
    return { secret, pubkey: getPublicKey(secret) };
  });
}

/** Sign an event of the given kind; `created_at` defaults to now. */
export function sign(
  who: Identity,
  kind: number,
  options: { content?: string; tags?: string[][]; created_at?: number } = {},
): NostrEvent {
  const { id, pubkey, created_at, tags, content, sig } = finalizeEvent({
    kind,
    content: options.content ?? "",
    tags: options.tags ?? [],
    created_at: options.created_at ?? Math.floor(Date.now() / 1000),
  }, who.secret);
  // A plain copy: finalizeEvent marks its result as verified with a symbol.
  return { id, pubkey, created_at, kind, tags, content, sig };
}

/** The N-Triples lines of `document` as `[subject, predicate, object]`. */
export function parseTriples(document: string): [string, string, string][] {
  return document.split("\n").filter(Boolean).map((line) => {
    const match = /^(<[^>]*>) (<[^>]*>) (.*) \.$/.exec(line);
    if (!match) throw new Error(`Not an N-Triples line: ${line}`);
    return [match[1], match[2], match[3]];
  });
}

/** Objects of all triples with the given vocabulary predicate IRI. */
export function objectsOf(document: string, predicateIri: string): string[] {
  return parseTriples(document)
    .filter(([, p]) => p === `<${predicateIri}>`)
    .map(([, , o]) => o);
}

/** A configuration with a small `maxLimit` unless overridden. */
export function config(overrides: Partial<Config> = {}): Config {
  return testConfig(overrides);
}

/** An event store on a fresh in-process triple store. */
export async function memoryEventStore(
  overrides: Partial<Config> = {},
): Promise<EventStore> {
  return await createEventStore(
    new MemoryTripleStore(),
    config(overrides),
  );
}

/** Seconds per day, for spreading events over time. */
export const DAY = 86400;

/**
 * The plain fields of an event. Signature verification caches its outcome in
 * a symbol property that must not take part in comparisons.
 */
export function plain(event: NostrEvent): NostrEvent {
  const { id, pubkey, created_at, kind, tags, content, sig } = event;
  return { id, pubkey, created_at, kind, tags, content, sig };
}

/** A {@link TripleStore} wrapper that counts calls and can fail inserts. */
export class CountingStore implements TripleStore {
  readonly inner: TripleStore;
  selects = 0;
  asks = 0;
  inserts = 0;
  /** When set, the next insert rejects with it (once). */
  failNextInsert?: Error;

  constructor(inner: TripleStore) {
    this.inner = inner;
  }

  /** Reads plus writes issued so far. */
  get calls(): number {
    return this.selects + this.asks + this.inserts;
  }

  insert(ntriples: string): Promise<void> {
    this.inserts++;
    const error = this.failNextInsert;
    if (error) {
      this.failNextInsert = undefined;
      return Promise.reject(error);
    }
    return this.inner.insert(ntriples);
  }
  select(sparql: string): Promise<SparqlBinding[]> {
    this.selects++;
    return this.inner.select(sparql);
  }
  ask(sparql: string): Promise<boolean> {
    this.asks++;
    return this.inner.ask(sparql);
  }
  query(sparql: string, options?: QueryOptions) {
    return this.inner.query(sparql, options);
  }
  size(): Promise<number> {
    return this.inner.size();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}
