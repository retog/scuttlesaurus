/**
 * People: the queries behind the Profile view (counts, follow lists,
 * followers, mutual follows) and the two replaceable events a person writes
 * about themselves and their follows: the profile (kind 0, NIP-01) and the
 * follow list (kind 3, NIP-02).
 *
 * Writes never build the event from the store. The newest event of the kind
 * is read from the relay first and its content and every tag that is not the
 * one being changed are kept, so what other clients put there survives. Writes
 * to the follow list run one after another, so that a second change always
 * starts from the first one's result.
 *
 * @module
 */
import { signal } from "@preact/signals";
import { pubkeyFromIri } from "../../../src/vocab.ts";
import { fetchFollowing } from "./feed.ts";
import type { Profile } from "./profiles.ts";
import { type Event, fetchEvents } from "./relay.ts";
import { notDeleted, notSuperseded, pubkeyTerm, select } from "./sparql.ts";
import { publish, session } from "./session.ts";

/** Counts of a person as the node knows them. */
export interface ProfileStats {
  /** People on their current follow list. */
  following: number;
  /** People on this node whose current follow list contains them. */
  followers: number;
  /** Their top-level notes (not replies). */
  notes: number;
}

/** A person in a list: who, and the name to sort by ("" when unknown). */
export interface PersonRef {
  pubkey: string;
  label: string;
}

/** Profile fields a person can edit, by their key in the kind 0 JSON. */
export type ProfileKey =
  | "name"
  | "display_name"
  | "about"
  | "website"
  | "nip05"
  | "picture"
  | "banner";

function count(rows: { n?: string }[]): number {
  return Number(rows[0]?.n ?? 0) || 0;
}

function nameOf(row: { displayName?: string; name?: string }): string {
  return (row.displayName || row.name || "").trim();
}

/** Counts of following, followers and notes of `pubkey` (three cheap queries). */
export async function fetchProfileStats(pubkey: string): Promise<ProfileStats> {
  const me = pubkeyTerm(pubkey);
  const [following, followers, notes] = await Promise.all([
    select(`
      SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE {
        ?list nostr:author ${me} ; nostr:kind 3 ; nostr:follows ?p .
        ${notSuperseded("?list")}
        ${notDeleted("?list")}
      }`),
    select(`
      SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE {
        ?list nostr:kind 3 ; nostr:author ?a ; nostr:follows ${me} .
        FILTER(?a != ${me})
        ${notSuperseded("?list")}
        ${notDeleted("?list")}
      }`),
    select(`
      SELECT (COUNT(DISTINCT ?e) AS ?n) WHERE {
        ?e nostr:author ${me} ; nostr:kind 1 .
        FILTER NOT EXISTS { ?e nostr:replyTo ?parent }
        ${notDeleted("?e")}
      }`),
  ]);
  return {
    following: count(following),
    followers: count(followers),
    notes: count(notes),
  };
}

/** The people on `pubkey`'s current follow list, with their names. */
export async function fetchFollowedPeople(
  pubkey: string,
): Promise<PersonRef[]> {
  const rows = await select(`
    SELECT DISTINCT ?p ?name ?displayName WHERE {
      ?list nostr:author ${
    pubkeyTerm(pubkey)
  } ; nostr:kind 3 ; nostr:follows ?p .
      ${notSuperseded("?list")}
      ${notDeleted("?list")}
      OPTIONAL { ?profile nostr:author ?p ; nostr:kind 0 . ${
    notSuperseded("?profile")
  } ${notDeleted("?profile")}
        OPTIONAL { ?profile nostr:name ?name }
        OPTIONAL { ?profile nostr:displayName ?displayName } }
    }`);
  return rows.flatMap((row) => {
    if (!row.p) return [];
    return [{ pubkey: pubkeyFromIri(row.p), label: nameOf(row) }];
  });
}

/** The people on this node whose current follow list contains `pubkey`. */
export async function fetchFollowerPeople(
  pubkey: string,
): Promise<PersonRef[]> {
  const me = pubkeyTerm(pubkey);
  const rows = await select(`
    SELECT DISTINCT ?a ?name ?displayName WHERE {
      ?list nostr:kind 3 ; nostr:author ?a ; nostr:follows ${me} .
      FILTER(?a != ${me})
      ${notSuperseded("?list")}
      ${notDeleted("?list")}
      OPTIONAL { ?profile nostr:author ?a ; nostr:kind 0 . ${
    notSuperseded("?profile")
  } ${notDeleted("?profile")}
        OPTIONAL { ?profile nostr:name ?name }
        OPTIONAL { ?profile nostr:displayName ?displayName } }
    }`);
  return rows.flatMap((row) => {
    if (!row.a) return [];
    return [{ pubkey: pubkeyFromIri(row.a), label: nameOf(row) }];
  });
}

/** Hex pubkeys that `viewer` follows and that also follow `pubkey`. */
export async function fetchFollowedBy(
  pubkey: string,
  viewer: string,
): Promise<string[]> {
  const me = pubkeyTerm(pubkey);
  const rows = await select(`
    SELECT DISTINCT ?f WHERE {
      ?mine nostr:author ${
    pubkeyTerm(viewer)
  } ; nostr:kind 3 ; nostr:follows ?f .
      ${notSuperseded("?mine")}
      ?theirs nostr:author ?f ; nostr:kind 3 ; nostr:follows ${me} .
      ${notSuperseded("?theirs")}
      FILTER(?f != ${me})
    }`);
  return rows.flatMap((row) => (row.f ? [pubkeyFromIri(row.f)] : []));
}

/** Whether a profile has anything a person can see (a name, a bio, a picture...). */
export function hasProfileFields(profile: Profile): boolean {
  return Boolean(
    profile.name || profile.displayName || profile.about || profile.picture ||
      profile.banner || profile.nip05 || profile.website,
  );
}

// --- Replaceable events ----------------------------------------------------------

/** The newest stored event of `kind` by `pubkey`, if any. */
async function newestEvent(
  kind: number,
  pubkey: string,
): Promise<Event | undefined> {
  const events = await fetchEvents([{
    kinds: [kind],
    authors: [pubkey],
    limit: 1,
  }]);
  return events.toSorted((a, b) => b.created_at - a.created_at)[0];
}

/**
 * A `created_at` that replaces `previous`: now, or one second after it when
 * the previous event is from this same second (NIP-01 breaks ties by id).
 */
function nextCreatedAt(previous?: Event): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(now, (previous?.created_at ?? 0) + 1);
}

/** The profile fields of a kind 0 content, in the shape the views use. */
export function profileFromContent(
  pubkey: string,
  content: Record<string, unknown>,
): Omit<Profile, "loaded"> {
  const text = (key: string): string | undefined => {
    const value = content[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    pubkey,
    name: text("name"),
    displayName: text("display_name"),
    about: text("about"),
    picture: text("picture"),
    banner: text("banner"),
    nip05: text("nip05"),
    website: text("website"),
  };
}

/**
 * Save the profile fields in `changes` (an empty string removes a field) and
 * keep every other field of the current kind 0 as it is. Resolves with the
 * new content. Refuses, changing nothing, when the current content cannot be
 * read as a JSON object.
 */
export async function saveProfile(
  changes: Partial<Record<ProfileKey, string>>,
): Promise<Record<string, unknown>> {
  const me = session.value?.pubkey;
  if (!me) throw new Error("Sign in to edit your profile");
  const latest = await newestEvent(0, me);
  let content: Record<string, unknown> = {};
  if (latest) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(latest.content || "{}");
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error(
        "Your current profile could not be read, so it was not changed.",
      );
    }
    content = { ...(parsed as Record<string, unknown>) };
  }
  for (
    const [key, value] of Object.entries(changes) as [ProfileKey, string][]
  ) {
    if (value.trim()) content[key] = value.trim();
    else delete content[key];
  }
  await publish({
    kind: 0,
    created_at: nextCreatedAt(latest),
    content: JSON.stringify(content),
    tags: latest?.tags ?? [],
  });
  return content;
}

// --- Follows ---------------------------------------------------------------------

/** The follow set of one viewer, as loaded (and as changed here). */
const viewerFollows = signal<
  { viewer: string; set: ReadonlySet<string> } | null
>(
  null,
);

/** Load the viewer's follow set once; a no-op when it is already loaded. */
export async function loadViewerFollows(viewer: string): Promise<void> {
  if (viewerFollows.peek()?.viewer === viewer) return;
  const set = await fetchFollowing(viewer);
  if (viewerFollows.peek()?.viewer === viewer) return;
  viewerFollows.value = { viewer, set };
}

/**
 * Whether `viewer` follows `pubkey`; `undefined` while the viewer's follow
 * list is not loaded. Reading it in a component subscribes to changes.
 */
export function followState(
  viewer: string | null,
  pubkey: string,
): boolean | undefined {
  const state = viewerFollows.value;
  if (!viewer || !state || state.viewer !== viewer) return undefined;
  return state.set.has(pubkey);
}

function setLocal(viewer: string, pubkey: string, follows: boolean): void {
  const state = viewerFollows.peek();
  if (!state || state.viewer !== viewer) return;
  const set = new Set(state.set);
  if (follows) set.add(pubkey);
  else set.delete(pubkey);
  viewerFollows.value = { viewer, set };
}

let queue: Promise<unknown> = Promise.resolve();

/** Run `task` after the follow-list writes already queued. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Follow or unfollow `pubkey` (NIP-02). Adds or removes exactly the `p` tag
 * for that key from the viewer's newest kind 3 and keeps its content and every
 * other tag. The state updates at once and is rolled back when the relay
 * refuses.
 */
export function setFollow(pubkey: string, follows: boolean): Promise<void> {
  const me = session.value?.pubkey;
  if (!me) return Promise.reject(new Error("Sign in to follow people"));
  setLocal(me, pubkey, follows);
  return serial(async () => {
    try {
      const latest = await newestEvent(3, me);
      const tags = latest?.tags ?? [];
      const listed = tags.some((t) => t[0] === "p" && t[1] === pubkey);
      if (listed === follows) return;
      const next = follows
        ? [...tags, ["p", pubkey]]
        : tags.filter((t) => !(t[0] === "p" && t[1] === pubkey));
      await publish({
        kind: 3,
        created_at: nextCreatedAt(latest),
        content: latest?.content ?? "",
        tags: next,
      });
    } catch (error) {
      setLocal(me, pubkey, !follows);
      throw error;
    }
  });
}
