/**
 * Seeded pseudo-random numbers for the seed world. The same seed gives the same
 * sequence everywhere, so the demo world is reproducible. Sub-streams are
 * named, so adding a draw in one part of the world does not reshuffle another.
 * @module
 */
import { createHash } from "node:crypto";

/** A deterministic random source. */
export interface Rng {
  /** A number in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A uniformly chosen element. The list must not be empty. */
  pick<T>(items: readonly T[]): T;
  /** An element chosen with the given non-negative weights. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** A shuffled copy of the list. */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` distinct elements in random order. */
  sample<T>(items: readonly T[], count: number): T[];
  /** An independent stream, named by `label` relative to this one. */
  fork(label: string): Rng;
}

/** A generator for the stream named by `seed` (mulberry32 on a SHA-256 seed). */
export function createRng(seed: string): Rng {
  const digest = createHash("sha256").update(seed).digest();
  let state = digest.readUInt32BE(0);
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(items) {
      if (items.length === 0) throw new Error("pick from an empty list");
      return items[Math.floor(next() * items.length)];
    },
    weighted(items, weights) {
      const total = weights.reduce((sum, w) => sum + w, 0);
      if (items.length === 0 || total <= 0) {
        throw new Error("weighted pick needs positive weights");
      }
      let roll = next() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i];
        if (roll < 0) return items[i];
      }
      return items[items.length - 1];
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    sample(items, count) {
      return rng.shuffle(items).slice(0, count);
    },
    fork(label) {
      return createRng(`${seed}/${label}`);
    },
  };
  return rng;
}
