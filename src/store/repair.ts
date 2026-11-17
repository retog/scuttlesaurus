/**
 * Start-up repair of the `supersededBy` / `deletedBy` bookkeeping.
 *
 * An insert that is cut off after the events of a group but before the
 * bookkeeping that belongs to them leaves events that count as stored (they
 * have `nostr:sig`) and are never planned again. This module finds what is
 * missing from the graph as it is, whatever caused it, and writes it with the
 * rules of the group commit ({@link resolveHeads}, {@link planDeletions}).
 * Nothing is read per event: when the graph is healthy the cost is a handful
 * of queries that start from the few replaceable, addressable and deletion
 * events.
 *
 * @module
 */
import type { NostrEvent, TripleStore } from "../types.ts";
import {
  eventIdFromIri,
  eventIri,
  PREFIXES,
  pubkeyFromIri,
  term,
} from "../vocab.ts";
import {
  chunks,
  planDeletions,
  readHeads,
  resolveHeads,
  VALUES_CHUNK,
} from "./commit_plan.ts";
import { iri, Triples } from "./ntriples.ts";

/** How much a repair wrote. */
export interface RepairResult {
  /** `nostr:supersededBy` triples written. */
  superseded: number;
  /** `nostr:deletedBy` triples written. */
  deleted: number;
}

type Rows = Record<string, { value: string }>[];

/** Keys of the addressable events (30000–39999) with several current versions. */
const ADDRESSABLE_KEYS = `SELECT ?addr WHERE {
  ?e nostr:address ?addr ; nostr:sig ?sig .
  MINUS { ?e nostr:supersededBy ?newer }
} GROUP BY ?addr HAVING (COUNT(?e) > 1)`;

/** Keys of the replaceable events (0, 3, 10000–19999) with several current versions. */
const REPLACEABLE_KEYS = `SELECT ?a ?k WHERE {
  ?e nostr:kind ?k ; nostr:author ?a ; nostr:sig ?sig .
  FILTER(?k IN (0, 3) || (?k >= 10000 && ?k < 20000))
  MINUS { ?e nostr:supersededBy ?newer }
} GROUP BY ?a ?k HAVING (COUNT(?e) > 1)`;

/**
 * Kind 5 events that may name a target of the same author without
 * `nostr:deletedBy`: by `e` tag; by `a` tag naming an addressable event not
 * newer than the request; by `a` tag where the author has an older replaceable
 * event (the kind of the coordinate cannot be read in SPARQL, so this one
 * over-approximates; {@link planDeletions} decides). The third is written with
 * the replaceable events first because the other order is several times slower
 * with thousands of deletion requests.
 */
const DELETIONS = [
  `SELECT DISTINCT ?d WHERE {
    ?d nostr:kind 5 ; nostr:author ?a ; nostr:sig ?sig ; nostr:deletes ?t .
    ?t nostr:author ?a ; nostr:kind ?k .
    FILTER(?k != 5)
    MINUS { ?t nostr:deletedBy ?by }
  }`,
  `SELECT DISTINCT ?d WHERE {
    ?d nostr:kind 5 ; nostr:author ?a ; nostr:sig ?sig ;
       nostr:createdAt ?dc ; nostr:deletesAddress ?addr .
    ?t nostr:address ?addr ; nostr:author ?a ; nostr:createdAt ?tc .
    FILTER(?tc <= ?dc)
    MINUS { ?t nostr:deletedBy ?by }
  }`,
  `SELECT DISTINCT ?d WHERE {
    {
      SELECT ?a ?tc WHERE {
        ?t nostr:kind ?k ; nostr:author ?a ; nostr:createdAt ?tc .
        FILTER(?k IN (0, 3) || (?k >= 10000 && ?k < 20000))
        MINUS { ?t nostr:deletedBy ?by }
      }
    }
    ?d nostr:author ?a ; nostr:kind 5 ; nostr:sig ?sig ;
       nostr:createdAt ?dc ; nostr:deletesAddress ?addr .
    FILTER(?tc <= ?dc)
  }`,
];

async function select(triples: TripleStore, query: string): Promise<Rows> {
  return await triples.select(PREFIXES + query);
}

async function byValues(
  triples: TripleStore,
  values: string[],
  query: (chunk: string) => string,
): Promise<Rows> {
  const rows: Rows = [];
  for (const group of chunks(values, VALUES_CHUNK)) {
    rows.push(...await select(triples, query(group.join(" "))));
  }
  return rows;
}

/** `supersededBy` for keys that have more than one current version. */
async function supersession(
  triples: TripleStore,
  out: Triples,
): Promise<number> {
  const addressable = (await select(triples, ADDRESSABLE_KEYS))
    .map((row) => iri(row.addr.value));
  const replaceable = (await select(triples, REPLACEABLE_KEYS)).map((row) => ({
    pubkey: pubkeyFromIri(row.a.value),
    kind: Number(row.k.value),
  }));
  if (addressable.length === 0 && replaceable.length === 0) return 0;
  const supersededBy = `<${term("supersededBy")}>`;
  let count = 0;
  for (
    const versions of (await readHeads(triples, addressable, replaceable))
      .values()
  ) {
    if (versions.length < 2) continue;
    const { best, losers } = resolveHeads(versions);
    for (const old of losers) {
      out.add(iri(eventIri(old.id)), supersededBy, iri(eventIri(best.id)));
      count++;
    }
  }
  return count;
}

/** `deletedBy` for the targets of deletion requests that lack it. */
async function deletions(triples: TripleStore, out: Triples): Promise<number> {
  const candidates = new Set<string>();
  for (const query of DELETIONS) {
    for (const row of await select(triples, query)) candidates.add(row.d.value);
  }
  if (candidates.size === 0) return 0;
  const events: NostrEvent[] = (await byValues(
    triples,
    [...candidates].map(iri),
    (values) =>
      `SELECT ?d ?a ?c ?tags WHERE {
        VALUES ?d { ${values} } ?d nostr:author ?a ; nostr:createdAt ?c .
        OPTIONAL { ?d nostr:tags ?tags }
      }`,
  )).map((row) => ({
    id: eventIdFromIri(row.d.value),
    pubkey: pubkeyFromIri(row.a.value),
    created_at: Number(row.c.value),
    kind: 5,
    tags: row.tags ? JSON.parse(row.tags.value) : [],
    content: "",
    sig: "",
  }));
  const pairs = await planDeletions(triples, events);
  const marked = new Set(
    (await byValues(
      triples,
      [...new Set(pairs.map(([target]) => iri(target)))],
      (values) =>
        `SELECT DISTINCT ?t WHERE { VALUES ?t { ${values} } ?t nostr:deletedBy ?by }`,
    )).map((row) => row.t.value),
  );
  const done = new Set<string>();
  let count = 0;
  for (const [target, by] of pairs) {
    // A target hidden by one request needs no second triple.
    if (marked.has(target) || done.has(target)) continue;
    done.add(target);
    out.add(iri(target), `<${term("deletedBy")}>`, iri(by));
    count++;
  }
  return count;
}

/**
 * Write the bookkeeping the graph lacks: `supersededBy` for every replaceable
 * or addressable key with more than one current version, `deletedBy` for the
 * same-author targets of kind 5 events that are not retracted yet. Does
 * nothing, and writes nothing, on a healthy graph.
 */
export async function repairBookkeeping(
  triples: TripleStore,
): Promise<RepairResult> {
  const out = new Triples();
  const superseded = await supersession(triples, out);
  const deleted = await deletions(triples, out);
  if (out.length > 0) await triples.insert(out.toString());
  return { superseded, deleted };
}
