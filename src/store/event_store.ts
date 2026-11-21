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
  eventIri,
  PREFIXES,
  pubkeyFromIri,
  pubkeyIri,
  term,
} from "../vocab.ts";
import {
  chunks,
  type GroupItem,
  MAX_SEEN_RELAYS,
  planGroup,
  type SeenCache,
  VALUES_CHUNK,
} from "./commit_plan.ts";
import {
  eventFromBinding,
  isEphemeral,
  isHex64,
  relayIri,
} from "./event_triples.ts";
import {
  buildQuery,
  isSelective,
  type ParsedFilter,
  parseFilter,
} from "./filter_sparql.ts";
import { dateLiteral, dayNumberToIso, iri } from "./ntriples.ts";
import { repairBookkeeping } from "./repair.ts";

/** Events may be at most this far ahead of the clock (seconds). */
const MAX_FUTURE_SECONDS = 15 * 60;
/** Distinct days loaded per query when reading the id set at start. */
const LOAD_DAYS_PER_QUERY = 16;
/** Widest window, in days, of the widening search for unselective filters. */
const MAX_WINDOW_DAYS = 256;
/** Window used when counting, where no early exit is possible. */
const COUNT_WINDOW_DAYS = 31;
const SECONDS_PER_DAY = 86400;
/** Default largest group: events, and estimated N-Triples bytes. */
const DEFAULT_GROUP_EVENTS = 500;
const DEFAULT_GROUP_BYTES = 4 * 1024 * 1024;
/** Estimated size of an event's triples apart from content and tags. */
const SIZE_OVERHEAD = 1200;
/** Estimated size of the one triple a known event gets for another relay. */
const SEEN_ON_SIZE = 200;
/** Events whose `seenOn` relays are remembered; the memory is dropped when full. */
const SEEN_CACHE_EVENTS = 50_000;

/** Limits of one group commit. */
export interface GroupOptions {
  /** Most events committed together (default 500). */
  maxEvents?: number;
  /** Largest estimated size of a group's N-Triples (default 4 MiB). */
  maxBytes?: number;
  /**
   * Milliseconds after a failed insert until the repair is tried without a
   * new event (default 30 s). Tests shorten it.
   */
  repairRetryMs?: number;
}

interface Pending {
  item: GroupItem;
  size: number;
  resolve: (result: AddResult) => void;
  reject: (error: unknown) => void;
}

const N = (name: Parameters<typeof term>[0]) => `<${term(name)}>`;

const dayOf = (seconds: number) => Math.floor(seconds / SECONDS_PER_DAY);
const dayOfIso = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86400_000;

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

/** How long after a failed insert the repair is tried without a new event. */
const REPAIR_RETRY_MS = 30_000;

class Store implements EventStore {
  readonly triples: TripleStore;
  readonly #config: Config;
  /** IRIs of all event ids in the graph (cheaper to load than hex ids). */
  readonly #ids = new Set<string>();
  /** The relays `nostr:seenOn` is known to hold, for events seen again. */
  #seen: SeenCache = new Map();
  readonly #listeners = new Set<
    (event: NostrEvent, info: EventListenerInfo) => void
  >();
  readonly #repairListeners = new Set<() => void>();
  #earliestDay?: number;
  #latestDay?: number;
  readonly #pending: Pending[] = [];
  readonly #group: Required<GroupOptions>;
  #committing = false;
  #committer: Promise<void> = Promise.resolve();
  #closed = false;
  /**
   * Set when an insert failed: the store may hold a prefix of the group (the
   * events but not their bookkeeping). The next commit repairs first.
   */
  #needsRepair = false;
  #repairTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(triples: TripleStore, config: Config, group: GroupOptions) {
    this.triples = triples;
    this.#config = config;
    this.#group = {
      maxEvents: group.maxEvents ?? DEFAULT_GROUP_EVENTS,
      maxBytes: group.maxBytes ?? DEFAULT_GROUP_BYTES,
      repairRetryMs: group.repairRetryMs ?? REPAIR_RETRY_MS,
    };
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
    const alreadyKnown = typeof event === "object" && event !== null &&
      this.has(event.id);
    const relay = alreadyKnown && options.seenOn !== undefined
      ? relayIri(options.seenOn)
      : undefined;
    if (alreadyKnown) {
      // Nothing to record: the relay is on the event already, or the event has
      // all the relays it may have, or it came without a usable relay.
      const recorded = this.#seen.get(eventIri(event.id));
      if (
        !relay || recorded?.has(relay) ||
        (recorded && recorded.size >= MAX_SEEN_RELAYS)
      ) return Promise.resolve({ status: "duplicate" });
    }
    // The signature of a known event is not looked at again: only that the
    // event really is the one stored, so that a relay cannot earn `seenOn`
    // credit with an id alone (the id is a hash of all the other fields).
    const reason = invalidReason(
      event,
      alreadyKnown || options.verified === true,
      Date.now() / 1000,
    );
    if (reason) return Promise.resolve({ status: "rejected", reason });
    if (alreadyKnown && !relay) return Promise.resolve({ status: "duplicate" });
    if (isEphemeral(event.kind)) {
      this.#notify(event, { seenOn: options.seenOn, stored: false });
      return Promise.resolve({ status: "ephemeral" });
    }
    return new Promise((resolve, reject) => {
      this.#pending.push({
        item: { event, seenOn: options.seenOn },
        size: alreadyKnown ? SEEN_ON_SIZE : SIZE_OVERHEAD +
          event.content.length * 2 + JSON.stringify(event.tags).length * 2,
        resolve,
        reject,
      });
      if (!this.#committing) {
        this.#committing = true;
        // Deferred so that adds issued in the same turn form one group.
        this.#committer = Promise.resolve().then(() => this.#commitLoop());
      }
    });
  }

  /** The committer: takes everything pending, one group at a time. */
  async #commitLoop(): Promise<void> {
    for (;;) {
      const group = this.#takeGroup();
      if (group.length === 0) break;
      if (this.#needsRepair) await this.#repair();
      let inserting = false;
      try {
        const plan = await planGroup(
          this.triples,
          (id) => this.has(id),
          group.map((p) => p.item),
          this.#seen,
        );
        if (plan.ntriples) {
          inserting = true;
          await this.triples.insert(plan.ntriples);
          inserting = false;
        }
        if (this.#seen.size > SEEN_CACHE_EVENTS) this.#seen = new Map();
        for (const [e, relays] of plan.seen) this.#seen.set(e, relays);
        for (const item of plan.stored) {
          const day = dayOf(item.event.created_at);
          this.#ids.add(eventIri(item.event.id));
          this.#earliestDay = Math.min(this.#earliestDay ?? day, day);
          this.#latestDay = Math.max(this.#latestDay ?? day, day);
        }
        // Subscribers hear of events in arrival order; a result is settled
        // only after its notification.
        group.forEach((pending, i) => {
          if (plan.outcomes[i].status === "stored") {
            this.#notify(pending.item.event, {
              seenOn: pending.item.seenOn,
              stored: true,
            });
          }
          pending.resolve(plan.outcomes[i]);
        });
      } catch (error) {
        // A failed insert may have written a prefix: events that are complete
        // but lack their bookkeeping. They are not in `#ids`, so offering
        // them again plans them afresh, but nothing promises that anybody
        // does; the repair finds the missing bookkeeping from the graph.
        if (inserting) {
          this.#needsRepair = true;
          this.#scheduleRepair();
        }
        for (const pending of group) pending.reject(error);
      }
    }
    this.#committing = false;
  }

  /**
   * On a quiet node no next group may come for a long time, so the repair is
   * also tried on a timer until it has succeeded.
   */
  #scheduleRepair(): void {
    if (this.#repairTimer !== undefined || this.#closed) return;
    this.#repairTimer = setTimeout(() => {
      this.#repairTimer = undefined;
      if (this.#closed || !this.#needsRepair) return;
      if (!this.#committing) {
        this.#committing = true;
        this.#committer = this.#repair().then(() => this.#commitLoop());
      }
      // Still needed if the repair fails or a commit is running right now.
      this.#scheduleRepair();
    }, this.#group.repairRetryMs);
    Deno.unrefTimer(this.#repairTimer as unknown as number);
  }

  /**
   * Write the bookkeeping a failed insert left out. A failure here is logged
   * and tried again before the next group; it never rejects the adds of
   * events that have nothing to do with it.
   */
  async #repair(): Promise<void> {
    let written: number;
    try {
      const { superseded, deleted } = await repairBookkeeping(this.triples);
      this.#needsRepair = false;
      clearTimeout(this.#repairTimer);
      this.#repairTimer = undefined;
      written = superseded + deleted;
      if (written > 0) {
        console.log(
          `store: repaired bookkeeping after a failed insert: ${superseded} supersededBy, ${deleted} deletedBy`,
        );
      }
    } catch (error) {
      console.error(
        `store: could not repair bookkeeping, will retry:`,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    // A closing store is about to close its triple store: nobody could read
    // the repaired state from it any more.
    if (written > 0 && !this.#closed) this.#notifyRepaired();
  }

  onRepaired(listener: () => void): () => void {
    this.#repairListeners.add(listener);
    return () => this.#repairListeners.delete(listener);
  }

  /**
   * Tell the repair listeners, after the repair's triples are in. They are
   * not awaited: the committer is waiting for the repair, and a listener's
   * work (such as recomputing the social graph) must not hold up the commits.
   * A throwing or rejecting listener is logged and affects nobody else.
   */
  #notifyRepaired(): void {
    const failed = (error: unknown) =>
      console.error("store: a repair listener failed:", error);
    for (const listener of [...this.#repairListeners]) {
      try {
        const result: unknown = listener();
        if (result instanceof Promise) result.catch(failed);
      } catch (error) {
        failed(error);
      }
    }
  }

  /** Up to the configured number of events and size from the queue. */
  #takeGroup(): Pending[] {
    let size = 0;
    let count = 0;
    while (count < this.#pending.length && count < this.#group.maxEvents) {
      size += this.#pending[count].size;
      if (count > 0 && size > this.#group.maxBytes) break;
      count++;
    }
    return this.#pending.splice(0, count);
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
          ?list nostr:author ?author ; nostr:kind ${kind} ; nostr:sig ?sig .
          MINUS { ?list nostr:supersededBy ?newer }
          MINUS { ?list nostr:deletedBy ?deletion }
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
          ?list nostr:author ?author ; nostr:kind 10002 ; nostr:sig ?sig .
          MINUS { ?list nostr:supersededBy ?newer }
          MINUS { ?list nostr:deletedBy ?deletion }
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
          MINUS { ?e nostr:deletedBy ?deletion }
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
    clearTimeout(this.#repairTimer);
    this.#repairTimer = undefined;
    await this.#committer;
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
 * already holds and writing the `supersededBy` / `deletedBy` triples that an
 * interrupted insert left out (see `repair.ts`). `config.maxLimit` caps the number of events per filter.
 * Closing the event store closes the triple store.
 */
export async function createEventStore(
  triples: TripleStore,
  config: Config,
  group: GroupOptions = {},
): Promise<EventStore> {
  const store = new Store(triples, config, group);
  await store.load();
  const { superseded, deleted } = await repairBookkeeping(triples);
  if (superseded + deleted > 0) {
    console.log(
      `store: repaired bookkeeping left by an interrupted write: ${superseded} supersededBy, ${deleted} deletedBy`,
    );
  }
  return store;
}
