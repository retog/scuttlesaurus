/**
 * Profiles (kind 0) by pubkey: a batching loader over SPARQL plus a cache of
 * signals, so every component showing the same author shares one query.
 *
 * @module
 */
import { type Signal, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { pubkeyFromIri } from "../../../src/vocab.ts";
import {
  notDeleted,
  notSuperseded,
  pubkeyTerm,
  select,
  values,
} from "./sparql.ts";
import { shortNpub } from "./nostr.ts";

/** The current profile of an author. Missing fields are `undefined`. */
export interface Profile {
  pubkey: string;
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  website?: string;
  /** False until the lookup finished (the other fields are then empty). */
  loaded: boolean;
}

const cache = new Map<string, Signal<Profile>>();
const queue = new Set<string>();
/** Pubkeys whose lookup was asked for, queued, done or seeded. */
const requested = new Set<string>();
let scheduled = false;

function slot(pubkey: string): Signal<Profile> {
  let s = cache.get(pubkey);
  if (!s) {
    s = signal({ pubkey, loaded: false });
    cache.set(pubkey, s);
  }
  return s;
}

async function flush(): Promise<void> {
  scheduled = false;
  const batch = [...queue];
  queue.clear();
  for (let i = 0; i < batch.length; i += 100) {
    const chunk = batch.slice(i, i + 100);
    const found = new Map<string, Profile>();
    try {
      const rows = await select(`
        SELECT ?author ?name ?displayName ?about ?picture ?banner ?nip05 ?website WHERE {
          ${values("author", chunk.map(pubkeyTerm))}
          ?profile nostr:author ?author ; nostr:kind 0 .
          ${notSuperseded("?profile")}
          ${notDeleted("?profile")}
          OPTIONAL { ?profile nostr:name ?name }
          OPTIONAL { ?profile nostr:displayName ?displayName }
          OPTIONAL { ?profile nostr:about ?about }
          OPTIONAL { ?profile nostr:picture ?picture }
          OPTIONAL { ?profile nostr:banner ?banner }
          OPTIONAL { ?profile nostr:nip05 ?nip05 }
          OPTIONAL { ?profile nostr:website ?website }
        }`);
      for (const row of rows) {
        const pubkey = pubkeyFromIri(row.author!);
        found.set(pubkey, {
          pubkey,
          name: row.name,
          displayName: row.displayName,
          about: row.about,
          picture: row.picture,
          banner: row.banner,
          nip05: row.nip05,
          website: row.website,
          loaded: true,
        });
      }
    } catch {
      // Node unavailable: show fallbacks; a later request may succeed.
      for (const pubkey of chunk) {
        const s = cache.get(pubkey);
        if (s && !s.peek().loaded) cache.delete(pubkey);
        requested.delete(pubkey);
      }
      continue;
    }
    for (const pubkey of chunk) {
      slot(pubkey).value = found.get(pubkey) ?? { pubkey, loaded: true };
    }
  }
}

/** Ask for a profile to be loaded in the next batch (no-op if cached). */
export function prefetchProfile(pubkey: string): void {
  // Not `cache.has()`: `useProfile` creates the slot while rendering, before
  // this runs in an effect.
  if (requested.has(pubkey)) return;
  requested.add(pubkey);
  slot(pubkey);
  queue.add(pubkey);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => setTimeout(flush, 10));
  }
}

/** Put already-known profile data into the cache (e.g. from a joined query). */
export function seedProfile(profile: Omit<Profile, "loaded">): void {
  requested.add(profile.pubkey);
  slot(profile.pubkey).value = { ...profile, loaded: true };
}

/** Drop a cached profile so that the next use fetches it again. */
export function invalidateProfile(pubkey: string): void {
  cache.delete(pubkey);
  requested.delete(pubkey);
}

/**
 * The profile of `pubkey`, loaded in batch with the others requested in the
 * same tick. Reading it in a component subscribes to updates.
 */
export function useProfile(pubkey: string): Profile {
  useEffect(() => prefetchProfile(pubkey), [pubkey]);
  return (cache.get(pubkey) ?? slot(pubkey)).value;
}

/** The best name to show: display name, name, or a shortened npub. */
export function displayNameOf(
  profile: Pick<Profile, "name" | "displayName"> | undefined,
  pubkey: string,
): string {
  return profile?.displayName?.trim() || profile?.name?.trim() ||
    shortNpub(pubkey);
}
