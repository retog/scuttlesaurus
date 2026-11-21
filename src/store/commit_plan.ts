/**
 * Planning of one group commit of the event store.
 *
 * A group of events is decided against the graph with a handful of queries
 * (retractions, current heads of replaceable keys, targets of deletion
 * requests) and then walked in arrival order against an in-memory overlay, so
 * that events within a group see each other exactly as if they had been added
 * one by one. The result is one N-Triples document for a single insert and
 * one outcome per event.
 *
 * @module
 */
import type { AddResult, NostrEvent, TripleStore } from "../types.ts";
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
  eventToTriples,
  isAddressable,
  isHex64,
  isReplaceable,
  parseCoordinate,
  relayIri,
} from "./event_triples.ts";
import { integer, iri, Triples } from "./ntriples.ts";

/** Terms per `VALUES` clause. */
export const VALUES_CHUNK = 300;

/** Split a list into pieces of at most `size` items. */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** An event waiting to be committed. */
export interface GroupItem {
  event: NostrEvent;
  seenOn?: string;
}

/** At most this many `nostr:seenOn` relays are recorded per event. */
export const MAX_SEEN_RELAYS = 4;

/** Event IRI → the relay IRIs the graph holds `nostr:seenOn` triples for. */
export type SeenCache = Map<string, Set<string>>;

/** What committing a group will do. */
export interface Plan {
  /** The result of each item, in the order of the group. */
  outcomes: AddResult[];
  /** The items that will be stored, in arrival order. */
  stored: GroupItem[];
  /**
   * All triples of the group; empty when there is nothing to write. Besides
   * the stored events this holds the `nostr:seenOn` triples of known events
   * that were received from another relay.
   */
  ntriples: string;
  /**
   * What the graph will say about `nostr:seenOn` once `ntriples` is inserted,
   * for the known events the group looked at and the stored events that have
   * a relay. To be merged into the {@link SeenCache} after the insert.
   */
  seen: SeenCache;
}

/** The newest version of a key as the planner sees it. */
export interface Head {
  id: string;
  created_at: number;
}

/** A version of an address, by event IRI. */
interface Version {
  iri: string;
  created_at: number;
}

const N = (name: Parameters<typeof term>[0]) => `<${term(name)}>`;

/** Whether `a` is the newer event: later `created_at`, then the lower id (NIP-01). */
function wins(a: Head, b: Head): boolean {
  return a.created_at !== b.created_at
    ? a.created_at > b.created_at
    : a.id < b.id;
}

/**
 * The versions of one replaceable or addressable key that are current at the
 * same time: the newest one wins (NIP-01), every other gets
 * `nostr:supersededBy <winner>`. The one rule shared by a group commit and the
 * start-up repair.
 */
export function resolveHeads(
  versions: Head[],
): { best: Head; losers: Head[] } {
  let best = versions[0];
  for (const head of versions) if (wins(head, best)) best = head;
  return { best, losers: versions.filter((head) => head.id !== best.id) };
}

/** What the graph says about the events of a group, read before the walk. */
interface State {
  /** `author IRI|event IRI` of every `nostr:deletes` triple on a group id. */
  deletedIds: Set<string>;
  /** `author IRI|address IRI` → newest deletion request `created_at`. */
  deletedAddresses: Map<string, number>;
  /** Address IRI → current heads of that key. */
  heads: Map<string, Head[]>;
  /** Event IRI → author IRI and kind, for events named by group deletions. */
  named: Map<string, { author: string; kind: number }>;
  /** Address IRI → stored versions, for addresses named by group deletions. */
  versions: Map<string, Version[]>;
}

async function select(
  triples: TripleStore,
  values: string[],
  query: (chunk: string) => string,
): Promise<Record<string, { value: string }>[]> {
  const rows: Record<string, { value: string }>[] = [];
  for (const group of chunks(values, VALUES_CHUNK)) {
    rows.push(...await triples.select(PREFIXES + query(group.join(" "))));
  }
  return rows;
}

const unique = <T>(items: T[]) => [...new Set(items)];

async function readState(
  triples: TripleStore,
  events: NostrEvent[],
): Promise<State> {
  const state: State = {
    deletedIds: new Set(),
    deletedAddresses: new Map(),
    heads: new Map(),
    named: new Map(),
    versions: new Map(),
  };
  const coordinates = events.flatMap((event) => {
    const coordinate = eventCoordinate(event);
    const address = coordinate && coordinateIri(coordinate);
    return address ? [{ event, address }] : [];
  });

  // Retractions: deletion requests of the same author naming the events.
  const ids = events.map((e) => iri(eventIri(e.id)));
  for (
    const row of await select(
      triples,
      ids,
      (values) =>
        `SELECT DISTINCT ?t ?a WHERE {
          VALUES ?t { ${values} }
          ?d nostr:kind 5 ; nostr:author ?a ; nostr:deletes ?t
        }`,
    )
  ) state.deletedIds.add(`${row.a.value}|${row.t.value}`);

  const addresses = unique(coordinates.map((c) => iri(c.address)));
  for (
    const row of await select(
      triples,
      addresses,
      (values) =>
        `SELECT ?addr ?a ?c WHERE {
          VALUES ?addr { ${values} }
          ?d nostr:kind 5 ; nostr:author ?a ;
             nostr:deletesAddress ?addr ; nostr:createdAt ?c
        }`,
    )
  ) {
    const key = `${row.a.value}|${row.addr.value}`;
    const created = Number(row.c.value);
    state.deletedAddresses.set(
      key,
      Math.max(created, state.deletedAddresses.get(key) ?? -1),
    );
  }

  // Current heads of every replaceable and addressable key.
  state.heads = await readHeads(
    triples,
    unique(
      coordinates.filter((c) => isAddressable(c.event.kind))
        .map((c) => iri(c.address)),
    ),
    coordinates.filter((c) => isReplaceable(c.event.kind)).map((c) => c.event),
  );

  await readDeletionTargets(triples, events, state);
  return state;
}

/**
 * The current versions (complete events without `nostr:supersededBy`) of the
 * given addresses (serialized IRI terms) and of the replaceable keys of the
 * given events, by address IRI. Replaceable keys are read per author and kind,
 * so a result may hold a few more keys than were asked for.
 */
export async function readHeads(
  triples: TripleStore,
  addressable: string[],
  replaceable: { pubkey: string; kind: number }[],
): Promise<Map<string, Head[]>> {
  const heads = new Map<string, Head[]>();
  const addHead = (key: string, row: Record<string, { value: string }>) => {
    const list = heads.get(key) ?? [];
    list.push({
      id: eventIdFromIri(row.e.value),
      created_at: Number(row.c.value),
    });
    heads.set(key, list);
  };
  const current = "nostr:sig ?sig . MINUS { ?e nostr:supersededBy ?newer }";
  for (
    const row of await select(
      triples,
      addressable,
      (values) =>
        `SELECT ?addr ?e ?c WHERE {
          VALUES ?addr { ${values} }
          ?e nostr:address ?addr ; nostr:createdAt ?c ; ${current}
        }`,
    )
  ) addHead(row.addr.value, row);
  const kinds = unique(replaceable.map((c) => integer(c.kind))).join(" ");
  for (
    const row of await select(
      triples,
      unique(replaceable.map((c) => iri(pubkeyIri(c.pubkey)))),
      (values) =>
        `SELECT ?a ?k ?e ?c WHERE {
          VALUES ?a { ${values} }
          VALUES ?k { ${kinds} }
          ?e nostr:author ?a ; nostr:kind ?k ; nostr:createdAt ?c ; ${current}
        }`,
    )
  ) {
    const address = coordinateIri({
      kind: Number(row.k.value),
      pubkey: pubkeyFromIri(row.a.value),
      identifier: "",
    });
    if (address) addHead(address, row);
  }
  return heads;
}

/** Look up what the kind 5 events of the group name. */
async function readDeletionTargets(
  triples: TripleStore,
  events: NostrEvent[],
  state: State,
): Promise<void> {
  const deletions = events.filter((e) => e.kind === 5);
  if (deletions.length === 0) return;
  const named = unique(
    deletions.flatMap((d) =>
      d.tags.filter((t) => t[0] === "e" && isHex64(t[1]))
        .map((t) => iri(eventIri(t[1])))
    ),
  );
  for (
    const row of await select(
      triples,
      named,
      (values) =>
        `SELECT ?t ?a ?k WHERE {
          VALUES ?t { ${values} } ?t nostr:author ?a ; nostr:kind ?k
        }`,
    )
  ) {
    state.named.set(row.t.value, {
      author: row.a.value,
      kind: Number(row.k.value),
    });
  }

  const addressable = new Set<string>();
  const replaceable = new Map<string, { pubkey: string; kind: number }>();
  for (const deletion of deletions) {
    for (const coordinate of coordinatesOf(deletion)) {
      const address = coordinateIri(coordinate);
      if (!address) continue;
      if (isAddressable(coordinate.kind)) addressable.add(iri(address));
      else if (isReplaceable(coordinate.kind)) {
        replaceable.set(address, coordinate);
      }
    }
  }
  const addVersion = (key: string, t: string, c: string) => {
    const versions = state.versions.get(key) ?? [];
    versions.push({ iri: t, created_at: Number(c) });
    state.versions.set(key, versions);
  };
  for (
    const row of await select(
      triples,
      [...addressable],
      (values) =>
        `SELECT ?addr ?t ?c WHERE {
          VALUES ?addr { ${values} } ?t nostr:address ?addr ; nostr:createdAt ?c
        }`,
    )
  ) addVersion(row.addr.value, row.t.value, row.c.value);
  for (const [address, { pubkey, kind }] of replaceable) {
    const rows = await triples.select(
      `${PREFIXES}SELECT ?t ?c WHERE {
        ?t nostr:author ${iri(pubkeyIri(pubkey))} ; nostr:kind ${kind} ;
           nostr:createdAt ?c
      }`,
    );
    for (const row of rows) addVersion(address, row.t.value, row.c.value);
  }
}

/**
 * Coordinates of the `a` tags of a deletion request that it may act on: its
 * author's own addressable events, or replaceable events (empty identifier).
 */
function coordinatesOf(deletion: NostrEvent) {
  return deletion.tags
    .filter((t) => t[0] === "a")
    .flatMap((t) => {
      const coordinate = parseCoordinate(t[1]);
      return coordinate && coordinate.pubkey === deletion.pubkey &&
          (isAddressable(coordinate.kind) ||
            (isReplaceable(coordinate.kind) && coordinate.identifier === ""))
        ? [coordinate]
        : [];
    });
}

/**
 * Which relays the graph already holds `nostr:seenOn` for, for the known
 * events of the group that arrived with a relay and are not in `seen` yet.
 */
async function readSeenOn(
  triples: TripleStore,
  events: string[],
): Promise<SeenCache> {
  const out: SeenCache = new Map(events.map((e) => [e, new Set<string>()]));
  for (
    const row of await select(
      triples,
      events.map(iri),
      (values) =>
        `SELECT ?e ?r WHERE { VALUES ?e { ${values} } ?e nostr:seenOn ?r }`,
    )
  ) out.get(row.e.value)?.add(row.r.value);
  return out;
}

/**
 * Decide a group of events. `known` tells which ids the graph already holds.
 * Reads the graph but never writes to it.
 *
 * A known event offered again with a relay it was not recorded on yet (at most
 * {@link MAX_SEEN_RELAYS} relays per event) yields just a `nostr:seenOn`
 * triple and the outcome `duplicate`. `seen` is the caller's memory of what
 * the graph holds, which saves the lookup.
 *
 * Order of the document, which decides what a reader sees if the insert is
 * cut off anywhere (the embedded log after a crash, the requests of the
 * endpoint store): each event's triples complete with its `nostr:sig`, then
 * the `nostr:seenOn` additions, then the `supersededBy` / `deletedBy`
 * bookkeeping last.
 *
 * The graph only grows, so the two kinds of damage a cut can leave are not
 * equal. Bookkeeping that is missing can be added later: the intermediate
 * state "event stored, bookkeeping missing" shows two current versions of a
 * profile or follow list (a merged follow list) until the repair has run, and
 * the repair (`repairBookkeeping`, at start and after a failed insert)
 * finds it from the graph alone. Bookkeeping that points at an event which
 * never became complete cannot be taken back; it would hide the older version
 * for good while nothing offers the newer one again. So a bookkeeping triple
 * is written only after the event it points at is complete, and the only
 * acceptable intermediate state is "stored, bookkeeping missing". Nothing
 * here relies on an event being offered again. Readers see the new event
 * before the old one is superseded for the moment between the two writes.
 */
export async function planGroup(
  triples: TripleStore,
  known: (id: string) => boolean,
  items: GroupItem[],
  seen: SeenCache = new Map(),
): Promise<Plan> {
  const fresh = unique(
    items.filter((i) => !known(i.event.id)).map((i) => i.event.id),
  );
  const freshEvents = fresh.map((id) =>
    items.find((i) => i.event.id === id)!.event
  );
  const state = freshEvents.length
    ? await readState(triples, freshEvents)
    : undefined;

  // `nostr:seenOn` of the group's events, as the graph will have it.
  const relayOf = (item: GroupItem) =>
    item.seenOn === undefined ? undefined : relayIri(item.seenOn);
  const unseen = unique(
    items.filter((i) => known(i.event.id) && relayOf(i)).map((i) =>
      eventIri(i.event.id)
    ).filter((e) => !seen.has(e)),
  );
  const looked: SeenCache = unseen.length
    ? await readSeenOn(triples, unseen)
    : new Map();
  const seenOnText = new Triples();
  // Working copies, so that nothing in `seen` changes before the insert.
  const relays: SeenCache = new Map();
  const relaysOf = (e: string) => {
    if (!relays.has(e)) {
      const recorded = looked.get(e) ?? seen.get(e);
      if (recorded) relays.set(e, new Set(recorded));
    }
    return relays.get(e);
  };

  // The overlay: everything the group has stored so far.
  const groupEvents = new Map<string, { author: string; kind: number }>();
  const groupVersions = new Map<string, Version[]>();
  const overlayIds = new Set<string>();
  const overlayAddresses = new Map<string, number>();
  const heads = new Map<string, Head[]>(
    [...state?.heads ?? []].map(([k, v]) => [k, [...v]]),
  );

  const eventText: string[] = [];
  const bookkeeping = new Triples();
  const outcomes: AddResult[] = [];
  const stored: GroupItem[] = [];

  for (const item of items) {
    const event = item.event;
    const eventIriValue = eventIri(event.id);
    if (known(event.id) || groupEvents.has(eventIriValue)) {
      outcomes.push({ status: "duplicate" });
      const relay = relayOf(item);
      const recorded = relay && relaysOf(eventIriValue);
      if (recorded && !recorded.has(relay) && recorded.size < MAX_SEEN_RELAYS) {
        recorded.add(relay);
        seenOnText.add(iri(eventIriValue), N("seenOn"), iri(relay));
      }
      continue;
    }
    const authorIri = pubkeyIri(event.pubkey);
    const coordinate = eventCoordinate(event);
    const address = coordinate && coordinateIri(coordinate);

    const retracted = state!.deletedIds.has(`${authorIri}|${eventIriValue}`) ||
      overlayIds.has(`${authorIri}|${eventIriValue}`) ||
      (address !== undefined && Math.max(
            state!.deletedAddresses.get(`${authorIri}|${address}`) ?? -1,
            overlayAddresses.get(`${authorIri}|${address}`) ?? -1,
          ) >= event.created_at);
    if (retracted) {
      outcomes.push({
        status: "rejected",
        reason: "deleted: retracted by its author",
      });
      continue;
    }

    if (address) {
      const current = heads.get(address) ?? [];
      const { best, losers } = resolveHeads([
        { id: event.id, created_at: event.created_at },
        ...current,
      ]);
      for (const old of losers) {
        bookkeeping.add(
          iri(eventIri(old.id)),
          N("supersededBy"),
          iri(eventIri(best.id)),
        );
      }
      heads.set(address, [best]);
      const versions = groupVersions.get(address) ?? [];
      versions.push({ iri: eventIriValue, created_at: event.created_at });
      groupVersions.set(address, versions);
    }

    if (event.kind === 5) {
      markDeletions(
        event,
        state!,
        groupEvents,
        groupVersions,
        (target, by) => bookkeeping.add(iri(target), N("deletedBy"), iri(by)),
      );
      for (const tag of event.tags) {
        if (tag[0] === "e" && isHex64(tag[1])) {
          overlayIds.add(`${authorIri}|${eventIri(tag[1])}`);
        } else if (tag[0] === "a") {
          const parsed = parseCoordinate(tag[1]);
          const target = parsed && coordinateIri(parsed);
          if (!target) continue;
          const key = `${authorIri}|${target}`;
          overlayAddresses.set(
            key,
            Math.max(event.created_at, overlayAddresses.get(key) ?? -1),
          );
        }
      }
    }

    groupEvents.set(eventIriValue, { author: authorIri, kind: event.kind });
    eventText.push(eventToTriples(event, { seenOn: item.seenOn }));
    const relay = relayOf(item);
    relays.set(eventIriValue, new Set(relay ? [relay] : []));
    stored.push(item);
    outcomes.push({ status: "stored" });
  }
  // What the caller may remember: events with a relay, and the known events
  // that were looked up (even without one, so that it need not look again).
  const remember: SeenCache = new Map();
  for (const [e, set] of relays) {
    if (set.size > 0 || looked.has(e)) remember.set(e, set);
  }
  return {
    outcomes,
    stored,
    ntriples: eventText.join("") + seenOnText + bookkeeping,
    seen: remember,
  };
}

/** NIP-09: `deletedBy` for the same-author targets a kind 5 event names. */
function markDeletions(
  deletion: NostrEvent,
  state: State,
  groupEvents: Map<string, { author: string; kind: number }>,
  groupVersions: Map<string, Version[]>,
  out: (target: string, by: string) => void,
): void {
  const author = pubkeyIri(deletion.pubkey);
  const targets = new Set<string>();
  for (const tag of deletion.tags) {
    if (tag[0] !== "e" || !isHex64(tag[1])) continue;
    const target = eventIri(tag[1]);
    const info = state.named.get(target) ?? groupEvents.get(target);
    if (info && info.author === author && info.kind !== 5) targets.add(target);
  }
  for (const coordinate of coordinatesOf(deletion)) {
    const address = coordinateIri(coordinate);
    if (!address) continue;
    const versions = [
      ...state.versions.get(address) ?? [],
      ...groupVersions.get(address) ?? [],
    ];
    for (const version of versions) {
      if (version.created_at <= deletion.created_at) targets.add(version.iri);
    }
  }
  const by = eventIri(deletion.id);
  for (const target of targets) out(target, by);
}

/**
 * The `deletedBy` pairs `[target IRI, deletion IRI]` that the given kind 5
 * events call for according to the graph as it is now, by the rules of
 * {@link planGroup}, whether or not the graph has them already.
 */
export async function planDeletions(
  triples: TripleStore,
  deletions: NostrEvent[],
): Promise<[target: string, by: string][]> {
  const state: State = {
    deletedIds: new Set(),
    deletedAddresses: new Map(),
    heads: new Map(),
    named: new Map(),
    versions: new Map(),
  };
  await readDeletionTargets(triples, deletions, state);
  const pairs: [string, string][] = [];
  for (const deletion of deletions) {
    markDeletions(deletion, state, new Map(), new Map(), (target, by) => {
      pairs.push([target, by]);
    });
  }
  return pairs;
}
