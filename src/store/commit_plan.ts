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

/** What committing a group will do. */
export interface Plan {
  /** The result of each item, in the order of the group. */
  outcomes: AddResult[];
  /** The items that will be stored, in arrival order. */
  stored: GroupItem[];
  /** All triples of the group; empty when nothing is stored. */
  ntriples: string;
}

interface Head {
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
  const addHead = (key: string, row: Record<string, { value: string }>) => {
    const heads = state.heads.get(key) ?? [];
    heads.push({
      id: eventIdFromIri(row.e.value),
      created_at: Number(row.c.value),
    });
    state.heads.set(key, heads);
  };
  const notSuperseded = "MINUS { ?e nostr:supersededBy ?newer }";
  const addressable = unique(
    coordinates.filter((c) => isAddressable(c.event.kind))
      .map((c) => iri(c.address)),
  );
  for (
    const row of await select(
      triples,
      addressable,
      (values) =>
        `SELECT ?addr ?e ?c WHERE {
          VALUES ?addr { ${values} }
          ?e nostr:address ?addr ; nostr:createdAt ?c . ${notSuperseded}
        }`,
    )
  ) addHead(row.addr.value, row);
  const replaceable = coordinates.filter((c) => isReplaceable(c.event.kind));
  for (
    const row of await select(
      triples,
      unique(replaceable.map((c) => iri(pubkeyIri(c.event.pubkey)))),
      (values) =>
        `SELECT ?a ?k ?e ?c WHERE {
          VALUES ?a { ${values} }
          VALUES ?k { ${
          unique(replaceable.map((c) => integer(c.event.kind))).join(" ")
        } }
          ?e nostr:author ?a ; nostr:kind ?k ; nostr:createdAt ?c . ${notSuperseded}
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

  await readDeletionTargets(triples, events, state);
  return state;
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
 * Decide a group of events. `known` tells which ids the graph already holds.
 * Reads the graph but never writes to it.
 */
export async function planGroup(
  triples: TripleStore,
  known: (id: string) => boolean,
  items: GroupItem[],
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
      let best: Head = { id: event.id, created_at: event.created_at };
      for (const head of current) if (wins(head, best)) best = head;
      for (const old of [{ id: event.id }, ...current]) {
        if (old.id === best.id) continue;
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
      markDeletions(event, state!, groupEvents, groupVersions, bookkeeping);
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
    stored.push(item);
    outcomes.push({ status: "stored" });
  }
  return {
    outcomes,
    stored,
    ntriples: stored.length ? eventText.join("") + bookkeeping : "",
  };
}

/** NIP-09: `deletedBy` for the same-author targets a kind 5 event names. */
function markDeletions(
  deletion: NostrEvent,
  state: State,
  groupEvents: Map<string, { author: string; kind: number }>,
  groupVersions: Map<string, Version[]>,
  out: Triples,
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
  const by = iri(eventIri(deletion.id));
  for (const target of targets) out.add(iri(target), N("deletedBy"), by);
}
