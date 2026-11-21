/**
 * The follow structure of the seed world, and the breadth-first distances it
 * gives from an owner. The plan makes the intended tiers: friends at one hop,
 * friends of friends at two, strangers at three; the muted person and the hub
 * are out of range.
 * @module
 */
import type { Persona } from "./model.ts";
import type { Rng } from "./random.ts";

/** The follow lists of a world. */
export interface FollowPlan {
  /** The current follow list of each persona, by handle. */
  readonly current: Map<string, string[]>;
  /** Older follow lists that a newer one replaced. */
  readonly earlier: Map<string, { follows: string[]; daysAgo: number }>;
  /** Public mute lists, by handle. */
  readonly mutes: Map<string, string[]>;
}

/**
 * Plans who follows whom. `personas` must hold exactly one owner, and the
 * handles of each tier are taken in the order given.
 */
export function planFollows(
  personas: readonly Persona[],
  rng: Rng,
): FollowPlan {
  const handles = (tier: Persona["tier"]) =>
    personas.filter((p) => p.tier === tier).map((p) => p.handle);
  const [owner] = handles("owner");
  const friends = handles("friend");
  const fof = handles("fof");
  const strangers = handles("stranger");
  const [muted] = handles("muted");
  const everyone = personas.map((p) => p.handle);
  const follows = new Map<string, Set<string>>(
    everyone.map((h) => [h, new Set<string>()]),
  );
  const add = (from: string, to: string) => {
    if (from !== to) follows.get(from)?.add(to);
  };

  for (const friend of friends) add(owner, friend);
  for (const friend of friends) {
    for (const other of rng.sample(friends, rng.int(2, 4))) add(friend, other);
    if (rng.chance(0.5)) add(friend, owner);
  }

  // Each friend of friends is followed by one to five friends; three of them
  // by many more.
  const popular = new Set(rng.sample(fof, 3));
  for (const person of fof) {
    const count = popular.has(person) ? rng.int(6, 9) : rng.int(1, 5);
    for (const friend of rng.sample(friends, count)) add(friend, person);
  }

  // Strangers are followed by friends of friends only.
  for (const stranger of strangers) {
    for (const person of rng.sample(fof, rng.int(1, 3))) {
      add(person, stranger);
    }
  }
  for (const person of fof) {
    for (const other of rng.sample(fof, rng.int(1, 2))) add(person, other);
  }
  for (const stranger of strangers) {
    for (const other of rng.sample(strangers, rng.int(1, 2))) {
      add(stranger, other);
    }
  }

  // The muted person is followed by two friends and follows some strangers of
  // their own; the owner has muted them.
  if (muted !== undefined) {
    for (const friend of rng.sample(friends, 2)) add(friend, muted);
    for (const person of rng.sample(fof, 2)) add(muted, person);
  }

  // The hub follows everybody else, and nobody follows it.
  const [hub] = handles("hub");
  if (hub !== undefined) {
    for (const other of everyone) if (other !== hub) add(hub, other);
  }

  const current = new Map<string, string[]>();
  for (const handle of everyone) {
    const list = [...(follows.get(handle) ?? [])];
    current.set(handle, list);
  }

  // One friend's older follow list still follows a friend of friends that the
  // newer list dropped.
  const earlier = new Map<string, { follows: string[]; daysAgo: number }>();
  const changer = "lucia.f";
  if (friends.includes(changer)) {
    const dropped = fof.find((person) =>
      !current.get(changer)?.includes(person) &&
      friendsFollowing(current, friends, person).length > 0
    );
    if (dropped !== undefined) {
      earlier.set(changer, {
        follows: [...(current.get(changer) ?? []), dropped],
        daysAgo: 40,
      });
    }
  }

  const mutes = new Map<string, string[]>();
  if (owner !== undefined && muted !== undefined) mutes.set(owner, [muted]);
  return { current, earlier, mutes };
}

function friendsFollowing(
  current: ReadonlyMap<string, readonly string[]>,
  friends: readonly string[],
  person: string,
): string[] {
  return friends.filter((friend) => current.get(friend)?.includes(person));
}

/**
 * Breadth-first distances from `owner` over `follows`. The owner is at 0. An
 * author is reached through the follow lists of those one hop closer; authors
 * muted by the owner are never reached. Authors out of range are absent.
 */
export function distancesFrom(
  owner: string,
  follows: ReadonlyMap<string, readonly string[]>,
  mutes: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const muted = new Set(mutes.get(owner) ?? []);
  const distance = new Map<string, number>([[owner, 0]]);
  let frontier = [owner];
  for (let hop = 1; frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const author of frontier) {
      for (const followed of follows.get(author) ?? []) {
        if (distance.has(followed) || muted.has(followed)) continue;
        distance.set(followed, hop);
        next.push(followed);
      }
    }
    frontier = next;
  }
  return distance;
}
