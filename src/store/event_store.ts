/**
 * The {@link EventStore}: Nostr semantics (NIP-01, NIP-02, NIP-09, NIP-45,
 * NIP-50, NIP-51, NIP-65) on top of a {@link TripleStore}.
 *
 * Nothing is ever deleted from the graph. A newer replaceable event adds
 * `nostr:supersededBy` to the older one, a deletion request adds
 * `nostr:deletedBy` to its targets, and queries exclude both.
 *
 * @module
 */
import { getEventHash, validateEvent, verifyEvent } from "@nostr/tools/pure";
import type {
  AddOptions,
  AddResult,
  Config,
  EventListenerInfo,
  EventStore,
  Filter,
  NostrEvent,
  SparqlBinding,
  StoreStats,
  TripleStore,
} from "../types.ts";
import {
  eventIdFromIri,
  eventIri,
  PREFIXES,
  pubkeyFromIri,
  pubkeyIri,
  term,
} from "../vocab.ts";
import {
  coordinateIri,
  eventCoordinate,
  eventFromBinding,
  eventToTriples,
  isAddressable,
  isEphemeral,
  isHex64,
  parseCoordinate,
} from "./event_triples.ts";
import {
  buildQuery,
  isSelective,
  type ParsedFilter,
  parseFilter,
} from "./filter_sparql.ts";
import {
  dateLiteral,
  dayNumberToIso,
  integer,
  iri,
  Triples,
} from "./ntriples.ts";

/** Events may be at most this far ahead of the clock (seconds). */
const MAX_FUTURE_SECONDS = 15 * 60;
/** Terms per `VALUES` clause in lookups by author. */
const VALUES_CHUNK = 300;
/** Distinct days loaded per query when reading the id set at start. */
const LOAD_DAYS_PER_QUERY = 16;
/** Widest window, in days, of the widening search for unselective filters. */
const MAX_WINDOW_DAYS = 256;
/** Window used when counting, where no early exit is possible. */
const COUNT_WINDOW_DAYS = 31;
const SECONDS_PER_DAY = 86400;

const N = (name: Parameters<typeof term>[0]) => `<${term(name)}>`;

const dayOf = (seconds: number) => Math.floor(seconds / SECONDS_PER_DAY);
const dayOfIso = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86400_000;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Whether `a` is the newer event: later `created_at`, then the lower id (NIP-01). */
function wins(a: { id: string; created_at: number }, b: typeof a): boolean {
  return a.created_at !== b.created_at
    ? a.created_at > b.created_at
    : a.id < b.id;
}

/** Order of query results: newest first, ties by ascending id. */
function byNewest(a: NostrEvent, b: NostrEvent): number {
  return b.created_at - a.created_at ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Why an event cannot be accepted, or undefined if it is valid. Strings must
 * be well-formed Unicode, otherwise the stored UTF-8 would differ from what
 * was signed and the event could not be reconstructed bit-exactly.
 */
function invalidReason(
  event: NostrEvent,
  verified: boolean,
  nowSeconds: number,
): string | undefined {
  if (typeof event !== "object" || event === null || !validateEvent(event)) {
    return "invalid: malformed event";
  }
  if (!isHex64(event.id) || !/^[0-9a-f]{128}$/.test(event.sig ?? "")) {
    return "invalid: malformed id or signature";
  }
  if (
    !Number.isSafeInteger(event.created_at) || event.created_at < 0 ||
    !Number.isInteger(event.kind) || event.kind < 0 || event.kind > 65535
  ) {
    return "invalid: malformed kind or created_at";
  }
  if (
    !event.content.isWellFormed() ||
    event.tags.some((tag) => tag.some((s) => !s.isWellFormed()))
  ) {
    return "invalid: content and tags must be well-formed Unicode";
  }
  if (getEventHash(event) !== event.id) return "invalid: id does not match";
  if (event.created_at > nowSeconds + MAX_FUTURE_SECONDS) {
    return "invalid: created_at is too far in the future";
  }
  if (!verified && !verifyEvent(event)) return "invalid: bad signature";
  return undefined;
}

class Store implements EventStore {
  readonly triples: TripleStore;
  readonly #config: Config;
  /** IRIs of all event ids in the graph (cheaper to load than hex ids). */
  readonly #ids = new Set<string>();
  readonly #listeners = new Set<
    (event: NostrEvent, info: EventListenerInfo) => void
  >();
  #earliestDay?: number;
  #latestDay?: number;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(triples: TripleStore, config: Config) {
    this.triples = triples;
    this.#config = config;
  }

  /** Read the id set and the day range from the graph. */
  async load(): Promise<void> {
    const days = await this.triples.select(
      `${PREFIXES}SELECT DISTINCT ?date WHERE { ?e nostr:date ?date }`,
    );
    const dates = days.map((b) => b.date.value).sort();
    for (const group of chunks(dates, LOAD_DAYS_PER_QUERY)) {
      // `nostr:sig` is written last, so events cut off by a crash are skipped.
      const rows = await this.triples.select(
        `${PREFIXES}SELECT ?e WHERE { VALUES ?date { ${
          group.map(dateLiteral).join(" ")
        } } ?e nostr:date ?date ; nostr:sig ?sig }`,
      );
      for (const row of rows) this.#ids.add(row.e.value);
    }
    if (dates.length) {
      this.#earliestDay = dayOfIso(dates[0]);
      this.#latestDay = dayOfIso(dates[dates.length - 1]);
    }
  }

  has(id: string): boolean {
    return isHex64(id) && this.#ids.has(eventIri(id));
  }

  subscribe(
    listener: (event: NostrEvent, info: EventListenerInfo) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(event: NostrEvent, info: EventListenerInfo): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event, info);
      } catch {
        // A faulty subscriber must not affect the others or the writer.
      }
    }
  }

  add(event: NostrEvent, options: AddOptions = {}): Promise<AddResult> {
    if (this.#closed) return Promise.reject(new Error("Event store is closed"));
    const reason = invalidReason(
      event,
      options.verified === true,
      Date.now() / 1000,
    );
    if (reason) return Promise.resolve({ status: "rejected", reason });
    if (isEphemeral(event.kind)) {
      this.#notify(event, { seenOn: options.seenOn, stored: false });
      return Promise.resolve({ status: "ephemeral" });
    }
    const run = this.#queue.then(() => this.#store(event, options));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #store(event: NostrEvent, options: AddOptions): Promise<AddResult> {
    if (this.has(event.id)) return { status: "duplicate" };
    if (await this.#isRetracted(event)) {
      return { status: "rejected", reason: "deleted: retracted by its author" };
    }
    const bookkeeping = new Triples();
    await this.#supersession(event, bookkeeping);
    if (event.kind === 5) await this.#deletions(event, bookkeeping);

    await this.triples.insert(
      eventToTriples(event, { seenOn: options.seenOn }) + bookkeeping,
    );

    this.#ids.add(eventIri(event.id));
    const day = dayOf(event.created_at);
    this.#earliestDay = Math.min(this.#earliestDay ?? day, day);
    this.#latestDay = Math.max(this.#latestDay ?? day, day);
    this.#notify(event, { seenOn: options.seenOn, stored: true });
    return { status: "stored" };
  }

  /** NIP-09: a deletion by the same author names the event or its address. */
  async #isRetracted(event: NostrEvent): Promise<boolean> {
    const coordinate = eventCoordinate(event);
    const address = coordinate && coordinateIri(coordinate);
    const byAddress = address
      ? `UNION { ?d nostr:deletesAddress ${iri(address)} ; nostr:createdAt ?c .
           FILTER(?c >= ${event.created_at}) }`
      : "";
    return await this.triples.ask(
      `${PREFIXES}ASK {
        ?d nostr:author ${iri(pubkeyIri(event.pubkey))} ; nostr:kind 5 .
        { ?d nostr:deletes ${iri(eventIri(event.id))} } ${byAddress}
      }`,
    );
  }

  /** Mark the loser among the new event and the current heads of its key. */
  async #supersession(event: NostrEvent, out: Triples): Promise<void> {
    const coordinate = eventCoordinate(event);
    if (!coordinate) return;
    const address = coordinateIri(coordinate);
    if (!address) return;
    const match = isAddressable(event.kind)
      ? `?e nostr:address ${iri(address)} .`
      : `?e nostr:author ${
        iri(pubkeyIri(event.pubkey))
      } ; nostr:kind ${event.kind} .`;
    const rows = await this.triples.select(
      `${PREFIXES}SELECT ?e ?createdAt WHERE {
        ${match} ?e nostr:createdAt ?createdAt .
        FILTER NOT EXISTS { ?e nostr:supersededBy ?newer }
      }`,
    );
    const heads = rows.map((row) => ({
      id: eventIdFromIri(row.e.value),
      created_at: Number(row.createdAt.value),
    }));
    let best: { id: string; created_at: number } = event;
    for (const head of heads) if (wins(head, best)) best = head;
    const superseded = [event, ...heads].filter((e) => e.id !== best.id);
    for (const old of superseded) {
      out.add(
        iri(eventIri(old.id)),
        N("supersededBy"),
        iri(eventIri(best.id)),
      );
    }
  }

  /** NIP-09: mark the events and address versions a kind 5 event names. */
  async #deletions(event: NostrEvent, out: Triples): Promise<void> {
    const author = iri(pubkeyIri(event.pubkey));
    const deletion = iri(eventIri(event.id));
    const targets = new Set<string>();

    const ids = event.tags
      .filter((t) => t[0] === "e" && isHex64(t[1]))
      .map((t) => iri(eventIri(t[1])));
    for (const group of chunks([...new Set(ids)], VALUES_CHUNK)) {
      const rows = await this.triples.select(
        `${PREFIXES}SELECT ?t WHERE {
          VALUES ?t { ${group.join(" ")} }
          ?t nostr:author ${author} ; nostr:kind ?k . FILTER(?k != 5)
        }`,
      );
      for (const row of rows) targets.add(row.t.value);
    }

    const addresses = new Set<string>();
    const replaceableKinds = new Set<number>();
    for (const tag of event.tags) {
      if (tag[0] !== "a") continue;
      const coordinate = parseCoordinate(tag[1]);
      if (!coordinate || coordinate.pubkey !== event.pubkey) continue;
      if (isAddressable(coordinate.kind)) {
        const address = coordinateIri(coordinate);
        if (address) addresses.add(iri(address));
      } else if (
        eventCoordinate({
          ...event,
          kind: coordinate.kind,
          tags: [],
        }) && coordinate.identifier === ""
      ) {
        replaceableKinds.add(coordinate.kind);
      }
    }
    const notNewer =
      `?t nostr:createdAt ?c . FILTER(?c <= ${event.created_at})`;
    for (const group of chunks([...addresses], VALUES_CHUNK)) {
      const rows = await this.triples.select(
        `${PREFIXES}SELECT ?t WHERE {
          VALUES ?a { ${group.join(" ")} } ?t nostr:address ?a . ${notNewer}
        }`,
      );
      for (const row of rows) targets.add(row.t.value);
    }
    for (const group of chunks([...replaceableKinds], VALUES_CHUNK)) {
      const rows = await this.triples.select(
        `${PREFIXES}SELECT ?t WHERE {
          VALUES ?k { ${group.map(integer).join(" ")} }
          ?t nostr:author ${author} ; nostr:kind ?k . ${notNewer}
        }`,
      );
      for (const row of rows) targets.add(row.t.value);
    }
    for (const target of targets) {
      out.add(iri(target), N("deletedBy"), deletion);
    }
  }

  // --- queries --------------------------------------------------------------

  async #events(
    filter: ParsedFilter,
    dates: string[] | undefined,
    limit: number,
  ): Promise<NostrEvent[]> {
    const run = async (since?: number, until?: number, cap?: number) => {
      const rows = await this.triples.select(
        buildQuery(filter, {
          projection: "events",
          dates,
          since,
          until,
          limit: cap,
        }),
      );
      return rows.map(eventFromBinding);
    };
    const events = await run(undefined, undefined, limit);
    if (events.length < limit) return events.sort(byNewest);
    // The cut-off may fall inside a group with the same `created_at`; the
    // query orders such a group by IRI, NIP-01 by id.
    const boundary = events[events.length - 1].created_at;
    const ties = await run(boundary, boundary);
    const newer = events.filter((e) => e.created_at > boundary);
    ties.sort(byNewest);
    return [...newer.sort(byNewest), ...ties].slice(0, limit);
  }

  /** The days to search: from the newest relevant day back to the oldest. */
  #dayRange(filter: ParsedFilter): [hi: number, lo: number] | undefined {
    if (this.#earliestDay === undefined || this.#latestDay === undefined) {
      return undefined;
    }
    const hi = Math.min(
      filter.until === undefined ? Infinity : dayOf(filter.until),
      this.#latestDay,
    );
    const lo = Math.max(
      filter.since === undefined ? -Infinity : dayOf(filter.since),
      this.#earliestDay,
    );
    return hi >= lo ? [hi, lo] : undefined;
  }

  async #evaluate(filter: ParsedFilter): Promise<NostrEvent[]> {
    if (filter.matchesNothing) return [];
    if (isSelective(filter)) {
      return await this.#events(filter, undefined, filter.limit);
    }
    const range = this.#dayRange(filter);
    if (!range) return [];
    const [first, lo] = range;
    const out: NostrEvent[] = [];
    let hi = first;
    let step = 1;
    while (hi >= lo && out.length < filter.limit) {
      const from = Math.max(hi - step + 1, lo);
      out.push(
        ...await this.#events(
          filter,
          daysBetween(from, hi),
          filter.limit - out.length,
        ),
      );
      hi = from - 1;
      step = Math.min(step * 2, MAX_WINDOW_DAYS);
    }
    return out;
  }

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    const merged = new Map<string, NostrEvent>();
    for (const filter of filters) {
      const parsed = parseFilter(filter, this.#config.maxLimit);
      for (const event of await this.#evaluate(parsed)) {
        merged.set(event.id, event);
      }
    }
    return [...merged.values()].sort(byNewest);
  }

  async count(filters: Filter[]): Promise<number> {
    const matched = new Set<string>();
    const collect = async (filter: ParsedFilter, dates?: string[]) => {
      const rows = await this.triples.select(
        buildQuery(filter, { projection: "ids", dates }),
      );
      for (const row of rows) matched.add(row.e.value);
    };
    for (const filter of filters) {
      const parsed = parseFilter(
        { ...filter, limit: undefined },
        this.#config.maxLimit,
      );
      if (parsed.matchesNothing) continue;
      if (isSelective(parsed)) {
        await collect(parsed);
        continue;
      }
      const range = this.#dayRange(parsed);
      if (!range) continue;
      for (let hi = range[0]; hi >= range[1]; hi -= COUNT_WINDOW_DAYS) {
        await collect(
          parsed,
          daysBetween(Math.max(hi - COUNT_WINDOW_DAYS + 1, range[1]), hi),
        );
      }
    }
    return matched.size;
  }

  // --- social lookups -------------------------------------------------------

  async #byAuthors<T>(
    pubkeys: string[],
    select: (values: string) => string,
    each: (row: SparqlBinding, author: string) => void,
  ): Promise<void> {
    const valid = [...new Set(pubkeys.filter(isHex64))];
    for (const group of chunks(valid, VALUES_CHUNK)) {
      const values = group.map((p) => iri(pubkeyIri(p))).join(" ");
      for (const row of await this.triples.select(select(values))) {
        each(row, pubkeyFromIri(row.author.value));
      }
    }
  }

  async #lists(
    pubkeys: string[],
    kind: number,
    predicate: string,
  ): Promise<Map<string, string[]>> {
    const lists = new Map<string, string[]>();
    await this.#byAuthors(
      pubkeys,
      (values) =>
        `${PREFIXES}SELECT ?author ?target WHERE {
          VALUES ?author { ${values} }
          ?list nostr:author ?author ; nostr:kind ${kind} .
          FILTER NOT EXISTS { ?list nostr:supersededBy ?newer }
          FILTER NOT EXISTS { ?list nostr:deletedBy ?deletion }
          OPTIONAL { ?list ${predicate} ?target }
        }`,
      (row, author) => {
        const list = lists.get(author) ?? [];
        lists.set(author, list);
        if (row.target) list.push(pubkeyFromIri(row.target.value));
      },
    );
    return lists;
  }

  follows(pubkeys: string[]): Promise<Map<string, string[]>> {
    return this.#lists(pubkeys, 3, N("follows"));
  }

  async mutes(pubkey: string): Promise<string[]> {
    return (await this.#lists([pubkey], 10000, N("mutes"))).get(pubkey) ?? [];
  }

  async relayLists(
    pubkeys: string[],
  ): Promise<Map<string, { read: string[]; write: string[] }>> {
    const lists = new Map<string, { read: string[]; write: string[] }>();
    await this.#byAuthors(
      pubkeys,
      (values) =>
        `${PREFIXES}SELECT ?author ?direction ?relay WHERE {
          VALUES ?author { ${values} }
          ?list nostr:author ?author ; nostr:kind 10002 .
          FILTER NOT EXISTS { ?list nostr:supersededBy ?newer }
          FILTER NOT EXISTS { ?list nostr:deletedBy ?deletion }
          { BIND("" AS ?direction) }
          UNION { ?list ${N("readRelay")} ?relay . BIND("read" AS ?direction) }
          UNION { ?list ${
          N("writeRelay")
        } ?relay . BIND("write" AS ?direction) }
        }`,
      (row, author) => {
        const list = lists.get(author) ?? { read: [], write: [] };
        lists.set(author, list);
        const direction = row.direction?.value;
        if (direction === "read" || direction === "write") {
          list[direction].push(row.relay.value);
        }
      },
    );
    return lists;
  }

  async relayScores(
    pubkeys: string[],
  ): Promise<Map<string, Map<string, number>>> {
    const scores = new Map<string, Map<string, number>>();
    await this.#byAuthors(
      pubkeys,
      (values) =>
        `${PREFIXES}SELECT ?author ?relay (COUNT(DISTINCT ?e) AS ?n) WHERE {
          VALUES ?author { ${values} }
          ?e nostr:author ?author ; nostr:seenOn ?relay .
          FILTER NOT EXISTS { ?e nostr:deletedBy ?deletion }
        } GROUP BY ?author ?relay`,
      (row, author) => {
        const relays = scores.get(author) ?? new Map<string, number>();
        scores.set(author, relays);
        relays.set(row.relay.value, Number(row.n.value));
      },
    );
    return scores;
  }

  async stats(): Promise<StoreStats> {
    const [authors] = await this.triples.select(
      `${PREFIXES}SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE { ?e nostr:author ?a }`,
    );
    return {
      events: this.#ids.size,
      triples: await this.triples.size(),
      authors: Number(authors.n.value),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    await this.triples.close();
  }
}

function daysBetween(from: number, to: number): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day++) days.push(dayNumberToIso(day));
  return days;
}

/**
 * Open an {@link EventStore} on `triples`, reading the ids of the events it
 * already holds. `config.maxLimit` caps the number of events per filter.
 * Closing the event store closes the triple store.
 */
export async function createEventStore(
  triples: TripleStore,
  config: Config,
): Promise<EventStore> {
  const store = new Store(triples, config);
  await store.load();
  return store;
}
