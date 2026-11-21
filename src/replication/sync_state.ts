/**
 * What has been fetched already, kept in `<dataDir>/sync-state.json`: per
 * author and relay the time range of regular events that were fetched from
 * that relay. After a restart only the gap since the last run, and any part of
 * the horizon that was never covered, is requested from each relay. A missing
 * or damaged file means starting over, never a crash.
 *
 * Coverage is kept per relay because relays do not hold the same events: an
 * author who was first fetched from a bootstrap relay and later turns out to
 * publish to another relay must still be backfilled from that relay.
 * @module
 */
import { dirname, join } from "@std/path";

const FORMAT_VERSION = 1;
/** Name of the state file inside the data directory. */
export const SYNC_STATE_FILE = "sync-state.json";

/** A closed range of `created_at` values, in unix seconds. */
export interface TimeRange {
  from: number;
  to: number;
}

/**
 * The parts of `[from, to]` that are not covered yet, newest gap first.
 *
 * The newer gap starts `overlap` seconds before the end of the covered range:
 * events reach relays late, and re-requesting them is cheap because known ids
 * are skipped.
 */
export function missingRanges(
  covered: TimeRange | undefined,
  from: number,
  to: number,
  overlap: number,
): TimeRange[] {
  if (!covered || covered.to < from || covered.from > to) {
    return [{ from, to }];
  }
  const gaps: TimeRange[] = [];
  gaps.push({ from: Math.max(from, covered.to - overlap), to });
  if (covered.from > from) gaps.push({ from, to: covered.from - 1 });
  return gaps;
}

function isRange(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    value.every((n) => Number.isInteger(n) && n >= 0) && value[0] <= value[1];
}

/** Coverage of regular events per author, persisted lazily and atomically. */
export class SyncState {
  readonly #path: string;
  readonly #flushMs: number;
  readonly #beforeSave: () => void;
  readonly #ranges: Map<string, Map<string, TimeRange>>;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dirty = false;
  #closed = false;
  #saving: Promise<void> = Promise.resolve();

  private constructor(
    path: string,
    ranges: Map<string, Map<string, TimeRange>>,
    flushMs: number,
    beforeSave: () => void,
  ) {
    this.#path = path;
    this.#ranges = ranges;
    this.#flushMs = flushMs;
    this.#beforeSave = beforeSave;
  }

  /**
   * Read the state file of `dataDir`. A file that is missing, unreadable, of
   * another version or not JSON yields an empty state; single malformed
   * entries are dropped.
   *
   * @param beforeSave Called before every write; lets the owner of the state
   *   record coverage that is only known at that moment (live subscriptions).
   */
  static async open(
    dataDir: string,
    options: { flushMs: number; beforeSave?: () => void },
  ): Promise<SyncState> {
    const path = join(dataDir, SYNC_STATE_FILE);
    const ranges = new Map<string, Map<string, TimeRange>>();
    try {
      const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
      const relays = typeof parsed === "object" && parsed !== null &&
          (parsed as { version?: unknown }).version === FORMAT_VERSION
        ? (parsed as { relays?: unknown }).relays
        : undefined;
      if (typeof relays === "object" && relays !== null) {
        for (const [relay, authors] of Object.entries(relays)) {
          if (typeof authors !== "object" || authors === null) continue;
          const known = new Map<string, TimeRange>();
          for (const [author, range] of Object.entries(authors)) {
            if (isRange(range)) {
              known.set(author, { from: range[0], to: range[1] });
            }
          }
          ranges.set(relay, known);
        }
      }
    } catch {
      // Starting over is the documented answer to a missing or corrupt file.
    }
    return new SyncState(
      path,
      ranges,
      options.flushMs,
      options.beforeSave ?? (() => {}),
    );
  }

  /** The range of regular events fetched from `relay` for an author. */
  get(relay: string, author: string): TimeRange | undefined {
    return this.#ranges.get(relay)?.get(author);
  }

  /**
   * Forget coverage that ends before `time`: it is older than any horizon in
   * use and would only be ignored.
   */
  prune(time: number): void {
    for (const [relay, authors] of this.#ranges) {
      for (const [author, range] of authors) {
        if (range.to < time) authors.delete(author);
      }
      if (authors.size === 0) this.#ranges.delete(relay);
    }
  }

  /**
   * Record that the regular events of `authors` created in `[from, to]` have
   * been fetched from `relay`. The range is merged into what is known when it overlaps or
   * touches it. Otherwise the record is ignored while it is `partial` (one page
   * of a longer request), and replaces the old range once the request is
   * complete and reaches further into the present.
   */
  extend(
    relay: string,
    authors: Iterable<string>,
    from: number,
    to: number,
    partial: boolean,
  ): void {
    if (this.#closed) return;
    const ranges = this.#ranges.get(relay) ?? new Map<string, TimeRange>();
    this.#ranges.set(relay, ranges);
    for (const author of authors) {
      const known = ranges.get(author);
      if (!known) {
        ranges.set(author, { from, to });
      } else if (from <= known.to + 1 && to >= known.from - 1) {
        known.from = Math.min(known.from, from);
        known.to = Math.max(known.to, to);
      } else if (!partial && to > known.to) {
        ranges.set(author, { from, to });
      } else {
        continue;
      }
      this.#markDirty();
    }
  }

  /** Write the state now if it changed. Never rejects. */
  async flush(): Promise<void> {
    // The hook may record coverage, which schedules a write; this is that write.
    this.#beforeSave();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#dirty) {
      this.#dirty = false;
      const document = JSON.stringify({
        version: FORMAT_VERSION,
        relays: Object.fromEntries(
          [...this.#ranges].map(([relay, authors]) => [
            relay,
            Object.fromEntries(
              [...authors].map(([author, r]) => [author, [r.from, r.to]]),
            ),
          ]),
        ),
      });
      this.#saving = this.#saving.then(() => this.#write(document));
    }
    await this.#saving;
  }

  /** Flush and stop scheduling writes. */
  async close(): Promise<void> {
    this.#beforeSave();
    this.#closed = true;
    await this.flush();
  }

  #markDirty(): void {
    this.#dirty = true;
    if (this.#timer === undefined && !this.#closed) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.flush();
      }, this.#flushMs);
    }
  }

  /** Write to a temporary file and rename it, so a crash never leaves half a file. */
  async #write(document: string): Promise<void> {
    const temporary = `${this.#path}.tmp`;
    try {
      await Deno.mkdir(dirname(this.#path), { recursive: true });
      await Deno.writeTextFile(temporary, document);
      await Deno.rename(temporary, this.#path);
    } catch (error) {
      console.error("replication: could not save the sync state:", error);
    }
  }
}
