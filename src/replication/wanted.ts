/**
 * What is fetched for an author and as which filters: the kinds and history
 * per social distance from `docs/ARCHITECTURE.md`, "What is fetched".
 * Replaceable and addressable kinds (NIP-01) have one current version each and
 * are asked for without a time limit; regular kinds only back to the horizon.
 * @module
 */
import type { Filter } from "../types.ts";

const SECONDS_PER_DAY = 86400;

/** Kinds every node needs of everybody in range to discover the graph. */
const DISCOVERY = [0, 3, 10002];
/** The owner's own lists are discovered too: mute list and Blossom servers. */
const OWNER_DISCOVERY = [0, 3, 10000, 10002, 10063];

const NEAR_REPLACEABLE = [0, 3, 10000, 10002, 10063, 30023];
const NEAR_REGULAR = [1, 5, 6, 7, 16, 1111];
const FAR_REPLACEABLE = [0, 3, 10002, 10063, 30023];
const FAR_REGULAR = [1, 5, 6, 16, 1111];

/** A recipe for the filters of one class of authors. */
export interface Wanted {
  /** Identifies the recipe; authors with the same key share filters. */
  key: string;
  /** Replaceable and addressable kinds: current versions, no time limit. */
  replaceable: readonly number[];
  /** Regular kinds: history back to the horizon, then live. */
  regular: readonly number[];
  /** No restriction on kinds at all (the owner). Then `regular` is unused. */
  unrestricted: boolean;
  /** How many days of regular events; 0 is unlimited. */
  horizonDays: number;
  /** Whether there is a history of regular events to page through. */
  ranged: boolean;
}

/** Days of history for an author at `distance`; the last entry repeats. */
export function horizonDaysFor(
  horizonDays: readonly number[],
  distance: number,
): number {
  if (horizonDays.length === 0) return 0;
  return Math.max(0, horizonDays[Math.min(distance, horizonDays.length - 1)]);
}

/** The recipe for an author asked for in full at `distance`. */
export function fullWanted(
  distance: number,
  horizonDays: readonly number[],
): Wanted {
  if (distance === 0) {
    return {
      key: "owner",
      replaceable: [],
      regular: [],
      unrestricted: true,
      horizonDays: 0,
      ranged: true,
    };
  }
  const days = horizonDaysFor(horizonDays, distance);
  const near = distance === 1;
  return {
    key: `${near ? "near" : "far"}:${days}`,
    replaceable: near ? NEAR_REPLACEABLE : FAR_REPLACEABLE,
    regular: near ? NEAR_REGULAR : FAR_REGULAR,
    unrestricted: false,
    horizonDays: days,
    ranged: true,
  };
}

/** The recipe for an author a bootstrap relay is asked about for discovery only. */
export function discoveryWanted(isOwner: boolean): Wanted {
  return {
    key: isOwner ? "owner-discovery" : "discovery",
    replaceable: isOwner ? OWNER_DISCOVERY : DISCOVERY,
    regular: [],
    unrestricted: false,
    horizonDays: 0,
    ranged: false,
  };
}

/** Unix time of the oldest regular event wanted at `now`; 0 for unlimited. */
export function horizonStart(wanted: Wanted, now: number): number {
  return wanted.horizonDays === 0
    ? 0
    : Math.max(0, now - wanted.horizonDays * SECONDS_PER_DAY);
}

/**
 * Whether a kind is replaceable without a `d` tag (NIP-01: 0, 3 and
 * 10000–19999): an author has at most one current event of it.
 */
export function isPlainReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/**
 * Current versions of the replaceable kinds (or of `kinds`, a part of them),
 * newest first, optionally paged.
 */
export function replaceableFilter(
  wanted: Wanted,
  authors: string[],
  until: number | undefined,
  limit: number,
  kinds: readonly number[] = wanted.replaceable,
): Filter {
  const filter: Filter = { authors, kinds: [...kinds], limit };
  if (until !== undefined) filter.until = until;
  return filter;
}

/** Regular events created in `[from, until]`, newest first. */
export function rangeFilter(
  wanted: Wanted,
  authors: string[],
  from: number,
  until: number,
  limit: number,
): Filter {
  const filter: Filter = { authors, until, limit };
  if (!wanted.unrestricted) filter.kinds = [...wanted.regular];
  if (from > 0) filter.since = from;
  return filter;
}

/** New events of every wanted kind, from `since` on, without end. */
export function liveFilter(
  wanted: Wanted,
  authors: string[],
  since: number,
): Filter {
  const filter: Filter = { authors, since };
  if (!wanted.unrestricted) {
    filter.kinds = [...wanted.replaceable, ...wanted.regular];
  }
  return filter;
}
