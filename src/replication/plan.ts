/**
 * Relay selection for the outbox model (NIP-65). A pure function: given who is
 * in range and where they say they publish, choose a small set of relays that
 * covers everybody. Contract: `docs/ARCHITECTURE.md`, "Planning".
 * @module
 */
import { isPublicRelayUrl } from "./public_relay.ts";
import { relayUrls } from "./urls.ts";

/** At most this many of an author's write relays are considered. */
export const WRITE_RELAYS_CONSIDERED = 4;
/** Every author should be covered by up to this many relays. */
export const COVERAGE = 2;

/** Everything {@link planRelays} decides from. */
export interface PlanInput {
  /** Authors in range with their distance from the owner. */
  authors: ReadonlyMap<string, number>;
  /** Current NIP-65 relay lists, for the authors that have one. */
  relayLists: ReadonlyMap<string, { read: string[]; write: string[] }>;
  /** Per author, how many of their events were first seen on which relay. */
  scores: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Relays for discovery and for authors without a relay list. */
  bootstrapRelays: readonly string[];
  /** Most relays to connect to, bootstrap relays included. */
  maxRelays: number;
  /** Relays that must not be used now, for example after repeated failures. */
  excluded: ReadonlySet<string>;
  /**
   * Whether relays from relay lists may be non-public (see
   * {@link isPublicRelayUrl}). Bootstrap relays are always allowed.
   */
  allowPrivateRelays: boolean;
}

/** What one chosen relay is asked for. */
export interface PlannedRelay {
  /** Authors to ask this relay for in full (everything the distance calls for). */
  authors: ReadonlySet<string>;
  /**
   * A bootstrap relay: besides `authors` it is asked for the discovery kinds
   * (profile, follow list, relay list) of everybody in range.
   */
  bootstrap: boolean;
}

/**
 * Choose the relays to connect to and the authors to ask each for.
 *
 * Bootstrap relays are always chosen (unless excluded). Beyond them relays are
 * picked greedily: the one that newly covers the most authors who still need
 * coverage, ties broken by how many of those authors' events were seen on it
 * before and then by URL, until `maxRelays` or until everybody is covered by
 * {@link COVERAGE} relays. Authors that ended up with no relay at all are
 * asked from the bootstrap relays.
 */
export function planRelays(input: PlanInput): Map<string, PlannedRelay> {
  const maxRelays = Math.max(0, Math.floor(input.maxRelays));
  const configured = new Set(relayUrls(input.bootstrapRelays));
  // A relay list is written by strangers; only the owner's own configuration
  // may point us at a private address.
  const mayUse = (url: string) =>
    input.allowPrivateRelays || configured.has(url) || isPublicRelayUrl(url);
  const bootstrap = [...configured]
    .filter((url) => !input.excluded.has(url))
    .slice(0, maxRelays);

  const candidatesOf = new Map<string, string[]>();
  const authorsOf = new Map<string, string[]>();
  for (const author of input.authors.keys()) {
    const written = relayUrls(input.relayLists.get(author)?.write ?? [])
      .filter(mayUse)
      .slice(0, WRITE_RELAYS_CONSIDERED);
    const candidates = written.length > 0
      ? written.filter((url) => !input.excluded.has(url))
      : bootstrap;
    candidatesOf.set(author, candidates);
    for (const url of candidates) {
      const list = authorsOf.get(url) ?? [];
      list.push(author);
      authorsOf.set(url, list);
    }
  }

  const stillNeeds = new Map<string, number>();
  for (const author of input.authors.keys()) stillNeeds.set(author, COVERAGE);
  const chosen = new Map<string, Set<string>>();

  const scoreOf = (author: string, url: string) =>
    input.scores.get(author)?.get(url) ?? 0;

  /** The most useful relay of `pool` that would cover somebody new. */
  const best = (pool: Iterable<string>): string | undefined => {
    let winner: { url: string; gain: number; score: number } | undefined;
    for (const url of pool) {
      let gain = 0;
      let score = 0;
      for (const author of authorsOf.get(url) ?? []) {
        if ((stillNeeds.get(author) ?? 0) === 0) continue;
        gain++;
        score += scoreOf(author, url);
      }
      if (gain === 0) continue;
      if (
        !winner || gain > winner.gain ||
        (gain === winner.gain &&
          (score > winner.score ||
            (score === winner.score && url < winner.url)))
      ) winner = { url, gain, score };
    }
    return winner?.url;
  };

  const choose = (url: string) => {
    const assigned = new Set<string>();
    for (const author of authorsOf.get(url) ?? []) {
      const need = stillNeeds.get(author) ?? 0;
      if (need === 0) continue;
      assigned.add(author);
      stillNeeds.set(author, need - 1);
    }
    chosen.set(url, assigned);
  };

  // Bootstrap relays first: they are in the plan whatever the authors say, and
  // authors without a relay list are spread over them by the same rule.
  const bootstrapPool = new Set(bootstrap);
  for (let url = best(bootstrapPool); url; url = best(bootstrapPool)) {
    bootstrapPool.delete(url);
    choose(url);
  }
  for (const url of bootstrapPool) choose(url);

  const outbox = [...authorsOf.keys()].filter((url) => !chosen.has(url));
  while (chosen.size < maxRelays) {
    const url = best(outbox.filter((candidate) => !chosen.has(candidate)));
    if (!url) break;
    choose(url);
  }

  // Authors the cap left without any relay are asked from the bootstrap relays.
  const fallback = bootstrap.filter((url) => chosen.has(url));
  for (const author of input.authors.keys()) {
    if (stillNeeds.get(author) !== COVERAGE) continue;
    const ranked = [...fallback].sort((a, b) =>
      scoreOf(author, b) - scoreOf(author, a) || (a < b ? -1 : 1)
    );
    for (const url of ranked.slice(0, COVERAGE)) chosen.get(url)?.add(author);
  }

  const plan = new Map<string, PlannedRelay>();
  const bootstrapSet = new Set(bootstrap);
  for (const [url, authors] of chosen) {
    plan.set(url, { authors, bootstrap: bootstrapSet.has(url) });
  }
  return plan;
}
