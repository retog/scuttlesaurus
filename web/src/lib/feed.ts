/**
 * Queries for short notes: the home feeds, an author's notes, threads,
 * counts, notifications and search. Every function is one SPARQL round trip
 * (a few are two) and returns plain objects; see `docs/DATA-MODEL.md`
 * ("Query idioms") for the patterns they follow.
 *
 * Feeds are read through the `nostr:date` window idiom: the newest UTC days
 * are queried first and the window is widened (doubling) until the page is
 * full or the oldest day of the store is reached, so a page costs the same
 * however large the store grows, and nothing ever sorts every note.
 *
 * Paging uses `until`, the `at` of the last row of the previous page. It is
 * inclusive, so consumers drop rows they already have (see `NoteFeed`).
 *
 * @module
 */
import { verifyEvent } from "@nostr/tools/pure";
import { eventIdFromIri, pubkeyFromIri, tagTerm } from "../../../src/vocab.ts";
import { distanceOf } from "./node.ts";
import { isHex64, type NoteEvent } from "./nostr.ts";
import { seedProfile } from "./profiles.ts";
import {
  eventTerm,
  int,
  iriRef,
  notDeleted,
  notSuperseded,
  pubkeyTerm,
  recentDates,
  type Row,
  select,
  str,
  values,
} from "./sparql.ts";
import type { ArticleSummary } from "../components/ArticleCard.tsx";

// --- Types -------------------------------------------------------------------------

/** Who reposted a note shown in a feed. */
export interface Repost {
  /** Id of the kind 6 event (what a deletion has to target). */
  id: string;
  pubkey: string;
  createdAt: number;
}

/** A short note as the views handle it. */
export interface NoteRow {
  id: string;
  pubkey: string;
  /** Unix seconds. */
  createdAt: number;
  content: string;
  /** The `tags` of the event, parsed from `nostr:tags`. */
  tags: string[][];
  kind: number;
  /** Id of the parent note (NIP-10), for replies. */
  replyTo?: string;
  /** Id of the thread root (NIP-10), for replies. */
  root?: string;
  /** Set when the feed shows this note because somebody reposted it. */
  repostedBy?: Repost;
  /**
   * Position in the feed (seconds): the repost time for a repost, else
   * `createdAt`. This is the paging cursor.
   */
  at: number;
  /** Unique within a feed: the repost id for a repost, else the note id. */
  key: string;
}

/** Replies, likes and reposts of a note, and the viewer's own undo handles. */
export interface NoteCounts {
  replies: number;
  likes: number;
  reposts: number;
  /** Event id of the viewer's reaction to the note, if any. */
  myLike?: string;
  /** Event id of the viewer's repost of the note, if any. */
  myRepost?: string;
}

/** A person found by {@link searchPeople} or {@link fetchPeopleNearYou}. */
export interface PersonRow {
  pubkey: string;
  name?: string;
  displayName?: string;
  nip05?: string;
  about?: string;
  picture?: string;
  /** For suggestions: the viewer's follows who follow this person. */
  via?: string[];
}

/** What a notification says happened. */
export type NotificationType = "reply" | "mention" | "like" | "repost";

/** An event by somebody else that concerns the viewer. */
export interface NotificationRow {
  /** Id of the event that caused it. */
  id: string;
  type: NotificationType;
  /** Who did it. */
  actor: string;
  createdAt: number;
  /** The note to open: the new note for replies and mentions, else the one liked or reposted. */
  noteId: string;
  /** A piece of the note concerned (empty when it is not known here). */
  excerpt: string;
  /** For likes: what was reacted with (`+`, an emoji…). */
  reaction?: string;
}

/** An ancestor that is not in the store. */
export interface MissingNote {
  id: string;
  missing: true;
}

/** A reply in a thread with its display depth. */
export interface ThreadReply {
  note: NoteRow;
  /** 0 = answers the focused note; capped at 2. */
  depth: number;
  /** Set when the note was flattened from deeper: whom it answers. */
  replyingTo?: string;
}

/** The thread around a note. */
export interface Thread {
  /** The note itself; `undefined` when unknown, deleted or out of range. */
  focus?: NoteRow;
  /** Chain of parents, the root first. A gap is a {@link MissingNote}. */
  ancestors: (NoteRow | MissingNote)[];
  /** Everything below the note, in reading order. */
  replies: ThreadReply[];
}

/** The note as the compose dialog and `NoteCard` take it. */
export function toEvent(note: NoteRow): NoteEvent {
  return {
    id: note.id,
    pubkey: note.pubkey,
    created_at: note.createdAt,
    content: note.content,
    kind: note.kind,
    tags: note.tags,
  };
}

// --- Parsing helpers -----------------------------------------------------------------

function parseTags(json: string | undefined): string[][] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter((t): t is string[] =>
      Array.isArray(t) && t.every((x) => typeof x === "string")
    );
  } catch {
    return [];
  }
}

function idOf(iri: string | undefined): string | undefined {
  if (!iri) return undefined;
  try {
    return eventIdFromIri(iri);
  } catch {
    return undefined;
  }
}

function keyOf(iri: string | undefined): string | undefined {
  if (!iri) return undefined;
  try {
    return pubkeyFromIri(iri);
  } catch {
    return undefined;
  }
}

/** The original event inside a repost's content, when it is genuine. */
function embeddedEvent(json: string | undefined): NoteRow | undefined {
  if (!json) return undefined;
  try {
    const event = JSON.parse(json) as {
      id: string;
      pubkey: string;
      kind: number;
      created_at: number;
      content: string;
      tags: string[][];
      sig: string;
    };
    if (event.kind !== 1 || !verifyEvent(event)) return undefined;
    return rowFromEvent(event);
  } catch {
    return undefined;
  }
}

function rowFromEvent(event: {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  kind: number;
}): NoteRow {
  const e = event.tags.filter((t) => t[0] === "e" && isHex64(t[1] ?? ""));
  const marked = (m: string) => e.find((t) => t[3] === m)?.[1];
  const unmarked = e.filter((t) => !t[3]).map((t) => t[1]);
  const replyTo = marked("reply") ?? marked("root") ?? unmarked.at(-1);
  const root = marked("root") ?? unmarked[0];
  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    content: event.content,
    tags: event.tags,
    kind: event.kind,
    replyTo,
    root,
    at: event.created_at,
    key: event.id,
  };
}

/** Turn one row of an {@link ENTRY} query into a note, or `undefined`. */
function entryToRow(r: Row): NoteRow | undefined {
  const id = idOf(r.e);
  const pubkey = keyOf(r.author);
  if (!id || !pubkey) return undefined;
  const at = Number(r.at);
  if (r.kind === "6" || r.kind === "16") {
    const origId = idOf(r.orig);
    const origAuthor = keyOf(r.oauthor);
    let note: NoteRow | undefined;
    if (origId && origAuthor) {
      note = {
        id: origId,
        pubkey: origAuthor,
        createdAt: Number(r.oat),
        content: r.ocontent ?? "",
        tags: parseTags(r.otags),
        kind: 1,
        replyTo: idOf(r.oreplyTo),
        root: idOf(r.oroot),
        at,
        key: id,
      };
    } else {
      // The original is not in the store; the repost carries a copy of it.
      note = embeddedEvent(r.content);
      if (note && origId && note.id !== origId) note = undefined;
    }
    if (!note) return undefined;
    return {
      ...note,
      at,
      key: id,
      repostedBy: { id, pubkey, createdAt: at },
    };
  }
  return {
    id,
    pubkey,
    createdAt: at,
    content: r.content ?? "",
    tags: parseTags(r.tags),
    kind: Number(r.kind),
    replyTo: idOf(r.replyTo),
    root: idOf(r.root),
    at,
    key: id,
  };
}

// --- Query fragments -----------------------------------------------------------------

/** The optional parts of a note (and of the original a repost points to). */
const ENTRY = `
  OPTIONAL { ?e nostr:content ?content }
  OPTIONAL { ?e nostr:tags ?tags }
  OPTIONAL { ?e nostr:replyTo ?replyTo }
  OPTIONAL { ?e nostr:root ?root }
  OPTIONAL {
    ?e nostr:reposts ?orig .
    OPTIONAL { ?orig nostr:author ?oauthor ; nostr:createdAt ?oat }
    OPTIONAL { ?orig nostr:content ?ocontent }
    OPTIONAL { ?orig nostr:tags ?otags }
    OPTIONAL { ?orig nostr:replyTo ?oreplyTo }
    OPTIONAL { ?orig nostr:root ?oroot }
  }`;

/** Drops reposts whose original was deleted. */
const NOT_GONE =
  "FILTER NOT EXISTS { ?e nostr:reposts ?gone . ?gone nostr:deletedBy ?goneBy }";

/**
 * A page of notes: `pattern` picks and orders the `?e ?kind ?author ?at` of
 * the page first (cheap, index driven); the optional parts are fetched only
 * for those rows, which is several times faster than joining them before the
 * sort.
 */
function pageQuery(pattern: string, want: number): string {
  return `
    SELECT ${ENTRY_VARS} WHERE {
      { SELECT ?e ?kind ?author ?at WHERE { ${pattern} }
        ORDER BY DESC(?at) LIMIT ${int(want)} }
      ${ENTRY}
    } ORDER BY DESC(?at)`;
}
const ENTRY_VARS =
  "?e ?kind ?author ?at ?content ?tags ?replyTo ?root ?orig ?oauthor ?oat ?ocontent ?otags ?oreplyTo ?oroot";

// --- The date window -----------------------------------------------------------------

const DAY_MS = 86_400_000;
let oldest: { day: number | undefined; checked: number } | undefined;

/** Start (ms) of the oldest UTC day that has an event; cached for 30 s. */
async function oldestDay(): Promise<number | undefined> {
  if (oldest && Date.now() - oldest.checked < 30_000) return oldest.day;
  const [row] = await select(
    "SELECT (MIN(?d) AS ?oldest) WHERE { ?e nostr:date ?d }",
  );
  const day = row?.oldest ? Date.parse(row.oldest.slice(0, 10)) : NaN;
  oldest = { day: Number.isFinite(day) ? day : undefined, checked: Date.now() };
  return oldest.day;
}

function dateTerms(newestDay: number, count: number, oldestDay: number) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = newestDay - i * DAY_MS;
    if (day < oldestDay) break;
    out.push(`"${new Date(day).toISOString().slice(0, 10)}"^^xsd:date`);
  }
  return out;
}

/**
 * Run `run` over a growing window of days, newest first, until `limit` rows
 * are collected or the store's oldest day is passed. `run` gets the day terms,
 * the inclusive upper bound `until` (seconds) and how many rows are still
 * needed; it must return them newest first.
 */
async function windowed<T>(
  until: number | undefined,
  limit: number,
  run: (dates: string[], until: number, want: number) => Promise<T[]>,
): Promise<T[]> {
  const first = await oldestDay();
  if (first === undefined) return [];
  // A little slack: events may be dated up to 15 minutes ahead.
  const bound = until ?? Math.floor(Date.now() / 1000) + 3600;
  let day = Math.floor(bound * 1000 / DAY_MS) * DAY_MS;
  let span = 2;
  const out: T[] = [];
  while (out.length < limit && day >= first) {
    const dates = dateTerms(day, span, first);
    out.push(...await run(dates, bound, limit - out.length));
    day -= span * DAY_MS;
    span = Math.min(span * 2, 128);
  }
  return out;
}

// --- Feeds ---------------------------------------------------------------------------

/** Options of {@link fetchFeed}. */
export interface FeedOptions {
  /** `following`: the viewer and the people on their current follow list. `network`: everything stored. */
  scope: "following" | "network";
  /** Hex pubkey whose follow list defines "following". */
  viewer: string | null;
  /** Inclusive upper bound for `NoteRow.at` (seconds), for paging. */
  until?: number;
  /** Page size (default 20). */
  limit?: number;
}

/**
 * One page of the home feed: top-level notes (kind 1 without a parent) and
 * reposts, newest first.
 */
export async function fetchFeed(options: FeedOptions): Promise<NoteRow[]> {
  const { scope, viewer, until, limit = 20 } = options;
  if (scope === "following" && !viewer) return [];
  // The people shown, as a subquery joined to the notes: several times faster
  // than an `EXISTS` filter on every note of the window.
  const people = scope === "following"
    ? `{ SELECT DISTINCT ?author WHERE {
           { ?list nostr:author ${pubkeyTerm(viewer!)} ; nostr:kind 3 ;
                   nostr:follows ?author .
             FILTER NOT EXISTS { ?list nostr:supersededBy ?listNewer } }
           UNION { BIND(${pubkeyTerm(viewer!)} AS ?author) }
         } }`
    : "";
  const rows = await windowed(until, limit, async (dates, bound, want) => {
    const found = await select(pageQuery(
      `
        ${values("date", dates)}
        VALUES ?kind { 1 6 }
        ?e nostr:date ?date ; nostr:kind ?kind ; nostr:author ?author ;
           nostr:createdAt ?at .
        FILTER(?at <= ${int(bound)})
        ${notDeleted("?e")}
        FILTER NOT EXISTS { ?e nostr:replyTo ?parent }
        ${NOT_GONE}
        ${people}`,
      want,
    ));
    return found.map(entryToRow).filter((n): n is NoteRow => !!n);
  });
  return rows;
}

/** Options of {@link fetchAuthorNotes}. */
export interface AuthorNotesOptions {
  /** Hex pubkey of the author. */
  author: string;
  /** Include the author's replies (default: only top-level notes and reposts). */
  withReplies: boolean;
  until?: number;
  limit?: number;
}

/** One page of an author's notes and reposts, newest first (for the profile). */
export async function fetchAuthorNotes(
  options: AuthorNotesOptions,
): Promise<NoteRow[]> {
  const { author, withReplies, until, limit = 20 } = options;
  const upper = until ?? Math.floor(Date.now() / 1000) + 3600;
  const rows = await select(pageQuery(
    `
      ?e nostr:author ${pubkeyTerm(author)} ; nostr:kind ?kind ;
         nostr:createdAt ?at .
      VALUES ?kind { 1 6 }
      BIND(${pubkeyTerm(author)} AS ?author)
      FILTER(?at <= ${int(upper)})
      ${notDeleted("?e")}
      ${NOT_GONE}
      ${withReplies ? "" : "FILTER NOT EXISTS { ?e nostr:replyTo ?parent }"}`,
    limit,
  ));
  return rows.map(entryToRow).filter((n): n is NoteRow => !!n);
}

/** Hex pubkeys the viewer currently follows (their newest kind 3 event). */
export async function fetchFollowing(viewer: string): Promise<Set<string>> {
  const rows = await select(`
    SELECT DISTINCT ?p WHERE {
      ?list nostr:author ${
    pubkeyTerm(viewer)
  } ; nostr:kind 3 ; nostr:follows ?p .
      ${notSuperseded("?list")}
    }`);
  return new Set(rows.flatMap((r) => keyOf(r.p) ?? []));
}

/**
 * A feed entry for a live event: a top-level note, or a repost together with
 * the (signature-checked) original it carries. `undefined` for anything else,
 * including replies.
 */
export function noteFromEvent(event: {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
}): NoteRow | undefined {
  if (event.kind === 1) {
    const note = rowFromEvent(event);
    return note.replyTo ? undefined : note;
  }
  if (event.kind === 6) {
    const note = embeddedEvent(event.content);
    if (!note) return undefined;
    return {
      ...note,
      at: event.created_at,
      key: event.id,
      repostedBy: {
        id: event.id,
        pubkey: event.pubkey,
        createdAt: event.created_at,
      },
    };
  }
  return undefined;
}

/** What {@link fetchFeedStatus} knows, to pick the right empty state. */
export interface FeedStatus {
  /** How many people the viewer currently follows. */
  follows: number;
  /** Whether the store holds any note at all. */
  anyNotes: boolean;
}

/** Why a feed may be empty: follows nobody, or nothing replicated yet. */
export async function fetchFeedStatus(
  viewer: string | null,
): Promise<FeedStatus> {
  const follows = viewer
    ? select(`
        SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE {
          ?list nostr:author ${pubkeyTerm(viewer)} ; nostr:kind 3 ;
                nostr:follows ?p .
          ${notSuperseded("?list")}
        }`)
    : Promise.resolve([]);
  const [any, f] = await Promise.all([
    select("SELECT ?e WHERE { ?e nostr:kind 1 } LIMIT 1"),
    follows,
  ]);
  return { follows: Number(f[0]?.n ?? 0), anyNotes: any.length > 0 };
}

// --- Single notes, threads, counts -----------------------------------------------------

/** Notes by id (those that are known and not deleted), in the order asked. */
export async function fetchNotes(ids: readonly string[]): Promise<NoteRow[]> {
  const wanted = [...new Set(ids.filter(isHex64))];
  if (wanted.length === 0) return [];
  const rows = await select(`
    SELECT ${ENTRY_VARS} WHERE {
      ${values("e", wanted.map(eventTerm))}
      ?e nostr:kind ?kind ; nostr:author ?author ; nostr:createdAt ?at .
      ${notDeleted("?e")}
      ${NOT_GONE}
      ${ENTRY}
    }`);
  const byId = new Map<string, NoteRow>();
  for (const row of rows) {
    const note = entryToRow(row);
    if (note) byId.set(note.id, note);
  }
  return wanted.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The note `id`, the chain of its parents and everything below it, in one
 * query: parents through `nostr:replyTo*`, the rest of the thread through
 * `nostr:root`.
 */
export async function fetchThread(id: string): Promise<Thread> {
  const focusTerm = eventTerm(id);
  const rows = await select(`
    SELECT ?e ?kind ?author ?at ?content ?tags ?replyTo ?root WHERE {
      { ${focusTerm} nostr:replyTo* ?e }
      UNION { ${focusTerm} nostr:root ?r . ?e nostr:root ?r }
      UNION { ?e nostr:root ${focusTerm} }
      OPTIONAL { ?e nostr:kind ?kind ; nostr:author ?author ; nostr:createdAt ?at }
      OPTIONAL { ?e nostr:content ?content }
      OPTIONAL { ?e nostr:tags ?tags }
      OPTIONAL { ?e nostr:replyTo ?replyTo }
      OPTIONAL { ?e nostr:root ?root }
      ${notDeleted("?e")}
      FILTER(!BOUND(?kind) || ?kind = 1)
    }`);
  const notes = new Map<string, NoteRow>();
  for (const row of rows) {
    const note = entryToRow({ ...row, kind: row.kind ?? "" });
    if (note && row.author) notes.set(note.id, note);
  }
  const focus = notes.get(id);
  if (!focus) return { ancestors: [], replies: [] };

  const ancestors: (NoteRow | MissingNote)[] = [];
  const seen = new Set([id]);
  for (let at: string | undefined = focus.replyTo; at && !seen.has(at);) {
    seen.add(at);
    const note = notes.get(at);
    if (!note) {
      ancestors.unshift({ id: at, missing: true });
      break;
    }
    ancestors.unshift(note);
    at = note.replyTo;
  }

  const children = new Map<string, NoteRow[]>();
  for (const note of notes.values()) {
    if (!note.replyTo || note.id === id) continue;
    (children.get(note.replyTo) ??
      children.set(note.replyTo, []).get(note.replyTo)!)
      .push(note);
  }
  const replies: ThreadReply[] = [];
  const visited = new Set([id]);
  const walk = (parent: NoteRow, level: number) => {
    const kids = (children.get(parent.id) ?? [])
      .toSorted((a, b) => a.createdAt - b.createdAt);
    for (const note of kids) {
      if (visited.has(note.id)) continue;
      visited.add(note.id);
      replies.push({
        note,
        depth: Math.min(level, 2),
        replyingTo: level > 2 ? parent.pubkey : undefined,
      });
      walk(note, level + 1);
    }
  };
  walk(focus, 0);
  return { focus, ancestors, replies };
}

/**
 * Replies, likes and reposts of each note in one grouped query. With
 * `viewer`, also the viewer's own reaction and repost event ids (to undo
 * them). Notes nobody reacted to are present with zeros.
 */
export async function fetchCounts(
  ids: readonly string[],
  viewer?: string | null,
): Promise<Map<string, NoteCounts>> {
  const wanted = [...new Set(ids.filter(isHex64))];
  const out = new Map<string, NoteCounts>();
  for (const id of wanted) out.set(id, { replies: 0, likes: 0, reposts: 0 });
  if (wanted.length === 0) return out;
  const mine = viewer
    ? `(MAX(IF(?a = ${pubkeyTerm(viewer)}, STR(?x), "")) AS ?mine)`
    : "";
  const rows = await select(`
    SELECT ?target ?type (COUNT(DISTINCT ?x) AS ?n) ${mine} WHERE {
      ${values("target", wanted.map(eventTerm))}
      { ?x nostr:replyTo ?target ; nostr:kind 1 . BIND("replies" AS ?type) }
      UNION {
        ?x nostr:reactsTo ?target .
        FILTER NOT EXISTS { ?x nostr:content "-" }
        BIND("likes" AS ?type)
      }
      UNION { ?x nostr:reposts ?target . BIND("reposts" AS ?type) }
      ?x nostr:author ?a .
      ${notDeleted("?x")}
    } GROUP BY ?target ?type`);
  for (const row of rows) {
    const counts = out.get(idOf(row.target) ?? "");
    if (!counts) continue;
    const n = Number(row.n);
    const own = idOf(row.mine);
    if (row.type === "replies") counts.replies = n;
    else if (row.type === "likes") {
      counts.likes = n;
      counts.myLike = own;
    } else if (row.type === "reposts") {
      counts.reposts = n;
      counts.myRepost = own;
    }
  }
  return out;
}

/** The people who reacted to a note most recently (hex pubkeys), at most `limit`. */
export async function fetchReactors(
  id: string,
  limit = 6,
): Promise<string[]> {
  const rows = await select(`
    SELECT ?a (MAX(?at) AS ?last) WHERE {
      ?x nostr:reactsTo ${
    eventTerm(id)
  } ; nostr:author ?a ; nostr:createdAt ?at .
      FILTER NOT EXISTS { ?x nostr:content "-" }
      ${notDeleted("?x")}
    } GROUP BY ?a ORDER BY DESC(?last) LIMIT ${int(limit)}`);
  return rows.flatMap((r) => keyOf(r.a) ?? []);
}

// --- Notifications -------------------------------------------------------------------

/** Options of {@link fetchNotifications}. */
export interface NotificationOptions {
  /** Inclusive upper bound (seconds), for paging. */
  until?: number;
  limit?: number;
}

/**
 * Replies to, mentions of, reactions to and reposts of the viewer's notes by
 * other people, newest first.
 */
export async function fetchNotifications(
  viewer: string,
  options: NotificationOptions = {},
): Promise<NotificationRow[]> {
  const { until, limit = 20 } = options;
  const me = pubkeyTerm(viewer);
  return await windowed(until, limit, async (dates, bound, want) => {
    const rows = await select(`
      SELECT ?e ?kind ?a ?at ?content ?target ?tauthor ?tcontent WHERE {
        { SELECT DISTINCT ?e ?kind ?a ?at WHERE {
            ${values("date", dates)}
            VALUES ?kind { 1 6 7 }
            ?e nostr:date ?date ; nostr:kind ?kind ; nostr:author ?a ;
               nostr:createdAt ?at .
            FILTER(?a != ${me} && ?at <= ${int(bound)})
            ${notDeleted("?e")}
            {
              ?e nostr:mentions ${me} . FILTER(?kind = 1)
            } UNION {
              ?e nostr:replyTo|nostr:reactsTo|nostr:reposts ?hit .
              ?hit nostr:author ${me} .
            }
          } ORDER BY DESC(?at) LIMIT ${int(want)} }
        OPTIONAL { ?e nostr:content ?content }
        OPTIONAL {
          ?e nostr:replyTo|nostr:reactsTo|nostr:reposts ?target .
          OPTIONAL { ?target nostr:author ?tauthor }
          OPTIONAL { ?target nostr:content ?tcontent }
        }
      } ORDER BY DESC(?at)`);
    const out: NotificationRow[] = [];
    for (const r of rows) {
      const id = idOf(r.e);
      const actor = keyOf(r.a);
      if (!id || !actor) continue;
      const kind = Number(r.kind);
      const target = idOf(r.target);
      const mineTarget = keyOf(r.tauthor) === viewer;
      if (kind === 1) {
        out.push({
          id,
          type: target && mineTarget ? "reply" : "mention",
          actor,
          createdAt: Number(r.at),
          noteId: id,
          excerpt: r.content ?? "",
        });
      } else if (target && mineTarget) {
        out.push({
          id,
          type: kind === 7 ? "like" : "repost",
          actor,
          createdAt: Number(r.at),
          noteId: target,
          excerpt: r.tcontent ?? "",
          reaction: kind === 7 ? (r.content || "+") : undefined,
        });
      }
    }
    return out;
  });
}

function seenKey(pubkey: string): string {
  return `scuttlesaurus.notifications.seen.${pubkey}`;
}

/**
 * When the viewer last opened the notifications (unix seconds), or 0 when
 * never. Kept in this browser; the Notifications view writes it.
 */
export function readNotificationsSeen(pubkey: string): number {
  try {
    return Number(localStorage.getItem(seenKey(pubkey))) || 0;
  } catch {
    return 0;
  }
}

/** Record that the viewer has seen the notifications up to now. */
export function writeNotificationsSeen(pubkey: string): void {
  try {
    localStorage.setItem(
      seenKey(pubkey),
      String(Math.floor(Date.now() / 1000)),
    );
  } catch {
    // marks just will not survive a reload
  }
}

/**
 * Whether any notification for `viewer` is newer than `since` (unix seconds).
 * The same conditions as {@link fetchNotifications}, answered with one query
 * that stops at the first match and only looks at the days since `since`
 * (at most 60).
 */
export async function hasNotificationsAfter(
  viewer: string,
  since: number,
): Promise<boolean> {
  const me = pubkeyTerm(viewer);
  const days = Math.min(
    60,
    Math.max(1, Math.ceil((Date.now() / 1000 - since) / 86_400) + 1),
  );
  const rows = await select(`
    SELECT ?e WHERE {
      ${values("date", recentDates(days))}
      VALUES ?kind { 1 6 7 }
      ?e nostr:date ?date ; nostr:kind ?kind ; nostr:author ?a ;
         nostr:createdAt ?at .
      FILTER(?a != ${me} && ?at > ${int(since)})
      ${notDeleted("?e")}
      {
        ?e nostr:mentions ${me} . FILTER(?kind = 1)
      } UNION {
        ?e nostr:replyTo|nostr:reactsTo|nostr:reposts ?hit .
        ?hit nostr:author ${me} .
      }
    } LIMIT 1`);
  return rows.length > 0;
}

// --- Search --------------------------------------------------------------------------

function hashtagVariants(tag: string): string[] {
  const lower = tag.toLowerCase();
  return [
    ...new Set([
      tag,
      lower,
      lower.charAt(0).toUpperCase() + lower.slice(1),
      lower.toUpperCase(),
    ]),
  ];
}

/**
 * Notes whose content contains `text` (case-insensitive), or, when `text`
 * starts with `#`, the notes tagged with that hashtag (exact, through
 * `tag:t`). Newest first; `until` pages as in the feeds.
 */
export async function searchNotes(
  text: string,
  options: { until?: number; limit?: number } = {},
): Promise<NoteRow[]> {
  const { until, limit = 20 } = options;
  const query = text.trim();
  if (!query) return [];
  const toRows = (found: Row[]) =>
    found.map(entryToRow).filter((n): n is NoteRow => !!n);
  if (query.startsWith("#")) {
    const tag = query.slice(1).trim();
    if (!tag) return [];
    const upper = until ?? Math.floor(Date.now() / 1000) + 3600;
    return toRows(
      await select(pageQuery(
        `
          ${values("tagValue", hashtagVariants(tag).map(str))}
          ?e ${iriRef(tagTerm("t"))} ?tagValue ;
             nostr:kind ?kind ; nostr:author ?author ; nostr:createdAt ?at .
          FILTER(?kind = 1 && ?at <= ${int(upper)})
          ${notDeleted("?e")}`,
        limit,
      )),
    );
  }
  const needle = str(query.toLowerCase());
  return await windowed(until, limit, async (dates, bound, want) =>
    toRows(
      await select(pageQuery(
        `
          ${values("date", dates)}
          ?e nostr:date ?date ; nostr:kind ?kind ; nostr:author ?author ;
             nostr:createdAt ?at ; nostr:content ?matched .
          FILTER(?kind = 1 && ?at <= ${int(bound)})
          FILTER(CONTAINS(LCASE(?matched), ${needle}))
          ${notDeleted("?e")}`,
        want,
      )),
    ));
}

function personFrom(r: Row): PersonRow | undefined {
  const pubkey = keyOf(r.author);
  if (!pubkey) return undefined;
  return {
    pubkey,
    name: r.name,
    displayName: r.displayName,
    nip05: r.nip05,
    about: r.about,
    picture: r.picture,
  };
}

/**
 * People whose current profile has `text` in its name, display name or NIP-05
 * (case-insensitive). The profiles found are put into the profile cache.
 */
export async function searchPeople(
  text: string,
  limit = 40,
): Promise<PersonRow[]> {
  const query = text.trim().toLowerCase();
  if (!query) return [];
  const rows = await select(`
    SELECT ?author ?name ?displayName ?nip05 ?about ?picture WHERE {
      ?profile nostr:kind 0 ; nostr:author ?author .
      ${notSuperseded("?profile")}
      ${notDeleted("?profile")}
      OPTIONAL { ?profile nostr:name ?name }
      OPTIONAL { ?profile nostr:displayName ?displayName }
      OPTIONAL { ?profile nostr:nip05 ?nip05 }
      OPTIONAL { ?profile nostr:about ?about }
      OPTIONAL { ?profile nostr:picture ?picture }
      FILTER(CONTAINS(LCASE(CONCAT(COALESCE(?name, ""), "\\n",
        COALESCE(?displayName, ""), "\\n", COALESCE(?nip05, ""))), ${
    str(query)
  }))
    } LIMIT ${int(limit)}`);
  const people = rows.flatMap((r) => personFrom(r) ?? []);
  for (const p of people) seedProfile(p);
  // Names that start with the query first, then the closer in the social
  // graph, then alphabetical.
  const label = (p: PersonRow) => (p.displayName || p.name || "").toLowerCase();
  const rank = (p: PersonRow) =>
    [p.name, p.displayName].some((n) => n?.toLowerCase().startsWith(query))
      ? 0
      : 1;
  return people.toSorted((a, b) =>
    rank(a) - rank(b) ||
    (distanceOf(a.pubkey) ?? 99) - (distanceOf(b.pubkey) ?? 99) ||
    label(a).localeCompare(label(b))
  );
}

/**
 * The current versions of articles (kind 30023) whose title, summary or
 * content contains `text` (case-insensitive), newest first.
 */
export async function searchArticles(
  text: string,
  limit = 30,
): Promise<ArticleSummary[]> {
  const query = text.trim().toLowerCase();
  if (!query) return [];
  const rows = await select(`
    SELECT ?article ?author ?title ?summary ?image ?publishedAt ?createdAt WHERE {
      ?version nostr:kind 30023 ; nostr:address ?article ;
               nostr:author ?author ; nostr:createdAt ?createdAt .
      ${notSuperseded("?version")}
      ${notDeleted("?version")}
      OPTIONAL { ?version nostr:title ?title }
      OPTIONAL { ?version nostr:summary ?summary }
      OPTIONAL { ?version nostr:image ?image }
      OPTIONAL { ?version nostr:publishedAt ?publishedAt }
      OPTIONAL { ?version nostr:content ?content }
      FILTER(CONTAINS(LCASE(CONCAT(COALESCE(?title, ""), "\\n",
        COALESCE(?summary, ""), "\\n", COALESCE(?content, ""))), ${str(query)}))
    } ORDER BY DESC(?createdAt) LIMIT ${int(limit)}`);
  return rows.flatMap((r) => {
    const pubkey = keyOf(r.author);
    if (!pubkey || !r.article) return [];
    return [{
      naddr: r.article.replace(/^nostr:/, ""),
      title: r.title?.trim() || "Untitled",
      summary: r.summary,
      image: r.image,
      pubkey,
      publishedAt: Number(r.publishedAt ?? r.createdAt),
    }];
  });
}

/** A hashtag and how often it was used. */
export interface TagCount {
  tag: string;
  count: number;
}

/** The most used hashtags (lower-cased) of the last `days` days. */
export async function fetchPopularTags(
  days = 21,
  limit = 12,
): Promise<TagCount[]> {
  const first = await oldestDay();
  if (first === undefined) return [];
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const rows = await select(`
    SELECT ?tag (COUNT(DISTINCT ?e) AS ?n) WHERE {
      ${values("date", dateTerms(today, days, first))}
      ?e nostr:date ?date ; nostr:kind 1 ; ${iriRef(tagTerm("t"))} ?raw .
      ${notDeleted("?e")}
      BIND(LCASE(?raw) AS ?tag)
    } GROUP BY ?tag ORDER BY DESC(?n) ?tag LIMIT ${int(limit)}`);
  return rows.map((r) => ({ tag: r.tag!, count: Number(r.n) }));
}

/**
 * People the viewer does not follow who are followed by at least `min` of the
 * viewer's follows, most followed first. `via` lists some of those follows.
 */
export async function fetchPeopleNearYou(
  viewer: string,
  limit = 8,
  min = 2,
): Promise<PersonRow[]> {
  const me = pubkeyTerm(viewer);
  const rows = await select(`
    SELECT ?p (COUNT(DISTINCT ?f) AS ?n)
           (GROUP_CONCAT(DISTINCT STR(?f); separator=" ") AS ?via) WHERE {
      ?mine nostr:author ${me} ; nostr:kind 3 ; nostr:follows ?f .
      ${notSuperseded("?mine")}
      ?theirs nostr:author ?f ; nostr:kind 3 ; nostr:follows ?p .
      ${notSuperseded("?theirs")}
      FILTER(?p != ${me})
      FILTER NOT EXISTS { ?mine nostr:follows ?p }
    } GROUP BY ?p HAVING (COUNT(DISTINCT ?f) >= ${int(min)})
    ORDER BY DESC(?n) ?p LIMIT ${int(limit)}`);
  return rows.flatMap((r) => {
    const pubkey = keyOf(r.p);
    if (!pubkey) return [];
    return [{
      pubkey,
      via: (r.via ?? "").split(" ").flatMap((iri) => keyOf(iri) ?? []),
    }];
  });
}
