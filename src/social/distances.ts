/**
 * Breadth-first social distances from the owner over follow lists (NIP-02),
 * leaving out the owner's public mute list (NIP-51, kind 10000) and capping
 * the number of authors. A pure function of what the store answers, so it is
 * tested without any I/O of its own.
 * @module
 */

/** What {@link computeDistances} needs to know about the world. */
export interface DistanceInput {
  /** Hex public key of the owner; without one the result is empty. */
  owner: string | undefined;
  /** Maximum number of follow hops from the owner. */
  hops: number;
  /** Upper bound on the number of authors, the owner included. */
  maxAuthors: number;
  /** Current follow list of each given pubkey that has one (NIP-02). */
  follows(pubkeys: string[]): Promise<Map<string, string[]>>;
  /** Current public mute list of a pubkey (NIP-51). */
  mutes(pubkey: string): Promise<string[]>;
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/**
 * Distances in follow hops from the owner, who is at distance 0.
 *
 * Each hop asks the store once for the follow lists of the whole previous hop.
 * Candidates are authors without a distance yet who are not muted by the
 * owner. When they do not all fit under `maxAuthors`, the ones followed by the
 * most authors of the previous hop are kept; ties are broken by pubkey, so the
 * result depends only on the follow lists.
 *
 * @returns Pubkey to distance; empty without an owner.
 */
export async function computeDistances(
  input: DistanceInput,
): Promise<Map<string, number>> {
  const distances = new Map<string, number>();
  const { owner } = input;
  if (!owner) return distances;
  distances.set(owner, 0);

  const hops = Math.max(0, Math.floor(input.hops));
  const capacity = Math.max(1, Math.floor(input.maxAuthors));
  const muted = new Set(hops > 0 ? await input.mutes(owner) : []);

  let frontier = [owner];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    const room = capacity - distances.size;
    if (room <= 0) break;

    const followers = new Map<string, number>();
    for (const list of (await input.follows(frontier)).values()) {
      // A follow list may name somebody twice; that is still one follower.
      for (const followed of new Set(list)) {
        if (
          !HEX_PUBKEY.test(followed) || distances.has(followed) ||
          muted.has(followed)
        ) continue;
        followers.set(followed, (followers.get(followed) ?? 0) + 1);
      }
    }

    const ranked = [...followers].sort(([a, countA], [b, countB]) =>
      countB - countA || (a < b ? -1 : 1)
    );
    const admitted = ranked.slice(0, room).map(([pubkey]) => pubkey).sort();
    for (const pubkey of admitted) distances.set(pubkey, hop);
    frontier = admitted;
  }
  return distances;
}
