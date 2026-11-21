/**
 * A short in-memory replay buffer for NIP-46 (Nostr Connect) messages.
 *
 * Kind 24133 events are ephemeral: relayed to whoever is subscribed at that
 * moment and then gone. A phone browser that is pushed to the background while
 * the person is in the signer app may be unsubscribed exactly when the answer
 * is sent, so the answer would be lost. The relay therefore keeps the accepted
 * messages for a couple of minutes and offers them to a `REQ` that matches,
 * like stored events. They are never written to the event store or the graph.
 *
 * Anyone may send kind 24133 events, so the buffer defends itself:
 *
 * - Most of the room is for recipients somebody has asked for: a pubkey that
 *   a connection subscribed to with `#p`, while that connection lives and for
 *   {@link INTEREST_LINGER_MS} after it ends (see {@link ReplayBuffer.watch}).
 *   Events for pubkeys nobody has asked for (a signer app that connects a
 *   moment later) share a small allowance of {@link MAX_UNWATCHED} events and
 *   {@link MAX_UNWATCHED_BYTES}, so a flood to random pubkeys only displaces
 *   itself.
 * - Events expire after {@link REPLAY_WINDOW_MS}; at most
 *   {@link MAX_PER_PUBKEY} are kept per recipient, {@link MAX_TOTAL} events
 *   and {@link MAX_TOTAL_BYTES} overall. The oldest are dropped first.
 * - Recipients are indexed, so adding an event costs the same however full
 *   the buffer is.
 *
 * What remains possible: someone who knows a recipient's pubkey and floods it
 * can push that recipient's real messages out of its 20 slots.
 *
 * @module
 */
import { matchFilter } from "@nostr/tools/filter";
import type { Filter } from "@nostr/tools/filter";
import type { NostrEvent } from "../types.ts";

/** How long an accepted Nostr Connect event can be replayed, in milliseconds. */
export const REPLAY_WINDOW_MS = 2 * 60 * 1000;
/** Most events kept for one `p`-tagged pubkey. */
export const MAX_PER_PUBKEY = 20;
/** Most events kept in total. */
export const MAX_TOTAL = 4000;
/** Most bytes of serialized events kept in total. */
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Most events kept whose recipients nobody has subscribed to. */
export const MAX_UNWATCHED = 200;
/** Most bytes of such events. */
export const MAX_UNWATCHED_BYTES = 2 * 1024 * 1024;
/** Recipients considered per event; a Nostr Connect event has one. */
export const MAX_RECIPIENTS = 4;
/** How long a recipient stays of interest after its last subscriber left. */
export const INTEREST_LINGER_MS = 2 * REPLAY_WINDOW_MS;
/** Most recipients remembered as of interest. */
export const MAX_WATCHED = 5000;

interface Entry {
  event: NostrEvent;
  /** When the relay accepted it (clock of the relay, not `created_at`). */
  receivedAt: number;
  /** The first {@link MAX_RECIPIENTS} valid pubkeys in its `p` tags. */
  recipients: string[];
  /** Whether a recipient was watched when it arrived. */
  watched: boolean;
  /** Length of the serialized event. */
  bytes: number;
}

interface Interest {
  /** Number of live connections subscribed to this recipient. */
  open: number;
  /** When interest ends once `open` is zero. */
  until: number;
}

const newestFirst = (a: NostrEvent, b: NostrEvent) =>
  b.created_at - a.created_at || (a.id < b.id ? 1 : -1);

/** The replay buffer of one relay. */
export class ReplayBuffer {
  readonly #now: () => number;
  /** By event id, in order of arrival (oldest first). */
  readonly #entries = new Map<string, Entry>();
  /** The entries of each recipient, oldest first. */
  readonly #byRecipient = new Map<string, Entry[]>();
  readonly #interest = new Map<string, Interest>();
  /** The entries that count against the unwatched allowance, oldest first. */
  readonly #unwatched = new Set<Entry>();
  #bytes = 0;
  #unwatchedBytes = 0;

  /** @param now The clock in milliseconds; tests pass their own. */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Number of events currently held (expired ones are dropped first). */
  get size(): number {
    this.#expire();
    return this.#entries.size;
  }

  /** Bytes of serialized events currently held. */
  get bytes(): number {
    this.#expire();
    return this.#bytes;
  }

  /**
   * Declares that a live connection wants events addressed to `pubkeys`, so
   * they are worth keeping. Returns a function to call when that connection
   * ends; interest then lingers for {@link INTEREST_LINGER_MS}, the time in
   * which the client may come back. When {@link MAX_WATCHED} pubkeys are
   * remembered, a new one takes the place of the one whose last subscriber
   * left longest ago; only when every remembered pubkey still has a live
   * subscriber is the new one not remembered.
   */
  watch(pubkeys: Iterable<string>): () => void {
    this.#expireInterest();
    const watched: string[] = [];
    for (const pubkey of new Set(pubkeys)) {
      let interest = this.#interest.get(pubkey);
      if (!interest) {
        if (this.#interest.size >= MAX_WATCHED && !this.#evictLingering()) {
          continue;
        }
        interest = { open: 0, until: 0 };
        this.#interest.set(pubkey, interest);
      }
      interest.open++;
      watched.push(pubkey);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const until = this.#now() + INTEREST_LINGER_MS;
      for (const pubkey of watched) {
        const interest = this.#interest.get(pubkey);
        if (!interest) continue;
        interest.open--;
        interest.until = until;
      }
    };
  }

  /**
   * Remembers an accepted event; the caller has checked it is Nostr Connect.
   * Returns whether it is in the buffer afterwards.
   */
  add(event: NostrEvent): boolean {
    this.#expire();
    if (this.#entries.has(event.id)) return true;
    const recipients = [
      ...new Set(
        event.tags
          .filter((tag) =>
            tag[0] === "p" && typeof tag[1] === "string" &&
            /^[0-9a-f]{64}$/.test(tag[1])
          )
          .map((tag) => tag[1]),
      ),
    ].slice(0, MAX_RECIPIENTS);
    if (recipients.length === 0) return false;
    const entry: Entry = {
      event,
      receivedAt: this.#now(),
      recipients,
      watched: recipients.some((pubkey) => this.#watched(pubkey)),
      bytes: JSON.stringify(event).length,
    };
    this.#entries.set(event.id, entry);
    this.#bytes += entry.bytes;
    if (!entry.watched) {
      this.#unwatched.add(entry);
      this.#unwatchedBytes += entry.bytes;
      for (const oldest of this.#unwatched) {
        if (
          this.#unwatched.size <= MAX_UNWATCHED &&
          this.#unwatchedBytes <= MAX_UNWATCHED_BYTES
        ) break;
        this.#remove(oldest);
      }
      if (!this.#entries.has(event.id)) return false;
    }
    for (const pubkey of recipients) {
      const mine = this.#byRecipient.get(pubkey) ?? [];
      if (mine.length === 0) this.#byRecipient.set(pubkey, mine);
      mine.push(entry);
      // The newest entry is last; drop the oldest beyond the bound.
      while (mine.length > MAX_PER_PUBKEY) this.#remove(mine[0]);
    }
    for (const oldest of this.#entries.values()) {
      if (
        this.#entries.size <= MAX_TOTAL && this.#bytes <= MAX_TOTAL_BYTES
      ) break;
      this.#remove(oldest);
    }
    return this.#entries.has(event.id);
  }

  /**
   * The buffered events that match any of `filters`, newest first. Each
   * filter's `since`, `until` and `limit` are honoured (`limit` keeps that
   * filter's newest events), as for stored events.
   */
  match(filters: Filter[]): NostrEvent[] {
    this.#expire();
    const found = new Map<string, NostrEvent>();
    for (const filter of filters) {
      const matching = this.#candidates(filter)
        .filter((event) => matchFilter(filter, event))
        .sort(newestFirst);
      const limited = typeof filter.limit === "number"
        ? matching.slice(0, Math.max(0, filter.limit))
        : matching;
      for (const event of limited) found.set(event.id, event);
    }
    return [...found.values()].sort(newestFirst);
  }

  /** The events a filter can match: those of its `#p` recipients, or all. */
  #candidates(filter: Filter): NostrEvent[] {
    const recipients = filter["#p"];
    if (!Array.isArray(recipients)) {
      return [...this.#entries.values()].map((entry) => entry.event);
    }
    const events = new Map<string, NostrEvent>();
    for (const pubkey of recipients) {
      for (const entry of this.#byRecipient.get(pubkey) ?? []) {
        events.set(entry.event.id, entry.event);
      }
    }
    return [...events.values()];
  }

  #watched(pubkey: string): boolean {
    const interest = this.#interest.get(pubkey);
    return interest !== undefined &&
      (interest.open > 0 || interest.until > this.#now());
  }

  #remove(entry: Entry): void {
    if (!this.#entries.delete(entry.event.id)) return;
    this.#bytes -= entry.bytes;
    if (this.#unwatched.delete(entry)) this.#unwatchedBytes -= entry.bytes;
    for (const pubkey of entry.recipients) {
      const mine = this.#byRecipient.get(pubkey);
      if (!mine) continue;
      const at = mine.indexOf(entry);
      if (at >= 0) mine.splice(at, 1);
      if (mine.length === 0) this.#byRecipient.delete(pubkey);
    }
  }

  #expire(): void {
    const oldest = this.#now() - REPLAY_WINDOW_MS;
    // Entries are in order of arrival, so the expired ones come first.
    for (const entry of this.#entries.values()) {
      if (entry.receivedAt > oldest) break;
      this.#remove(entry);
    }
  }

  /** Forgets the pubkey without subscribers that was left longest ago. */
  #evictLingering(): boolean {
    let oldest: string | undefined;
    let until = Infinity;
    for (const [pubkey, interest] of this.#interest) {
      if (interest.open <= 0 && interest.until < until) {
        oldest = pubkey;
        until = interest.until;
      }
    }
    return oldest !== undefined && this.#interest.delete(oldest);
  }

  #expireInterest(): void {
    const now = this.#now();
    for (const [pubkey, interest] of this.#interest) {
      if (interest.open <= 0 && interest.until <= now) {
        this.#interest.delete(pubkey);
      }
    }
  }
}
