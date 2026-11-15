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
 * The buffer is bounded: events expire after {@link REPLAY_WINDOW_MS}, at most
 * {@link MAX_PER_PUBKEY} are kept for each `p`-tagged pubkey and
 * {@link MAX_TOTAL} overall; the oldest are dropped first.
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

interface Entry {
  event: NostrEvent;
  /** When the relay accepted it (clock of the relay, not `created_at`). */
  receivedAt: number;
  /** The valid pubkeys in its `p` tags. */
  recipients: string[];
}

/** The replay buffer of one relay. */
export class ReplayBuffer {
  readonly #now: () => number;
  /** Oldest first. */
  #entries: Entry[] = [];

  /** @param now The clock in milliseconds; tests pass their own. */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Number of events currently held (expired ones are dropped first). */
  get size(): number {
    this.#expire();
    return this.#entries.length;
  }

  /** Remembers an accepted event; the caller has checked it is Nostr Connect. */
  add(event: NostrEvent): void {
    this.#expire();
    if (this.#entries.some((entry) => entry.event.id === event.id)) return;
    const recipients = [
      ...new Set(
        event.tags
          .filter((tag) => tag[0] === "p" && /^[0-9a-f]{64}$/.test(tag[1]))
          .map((tag) => tag[1]),
      ),
    ];
    this.#entries.push({ event, receivedAt: this.#now(), recipients });
    for (const pubkey of recipients) {
      const mine = this.#entries.filter((e) => e.recipients.includes(pubkey));
      // The newest entry is last; drop the oldest ones beyond the bound.
      for (
        const old of mine.slice(0, Math.max(0, mine.length - MAX_PER_PUBKEY))
      ) {
        this.#entries.splice(this.#entries.indexOf(old), 1);
      }
    }
    if (this.#entries.length > MAX_TOTAL) {
      this.#entries.splice(0, this.#entries.length - MAX_TOTAL);
    }
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
      const matching = this.#entries
        .map((entry) => entry.event)
        .filter((event) => matchFilter(filter, event))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
      const limited = typeof filter.limit === "number"
        ? matching.slice(0, Math.max(0, filter.limit))
        : matching;
      for (const event of limited) found.set(event.id, event);
    }
    return [...found.values()].sort((a, b) =>
      b.created_at - a.created_at || (a.id < b.id ? 1 : -1)
    );
  }

  #expire(): void {
    const oldest = this.#now() - REPLAY_WINDOW_MS;
    this.#entries = this.#entries.filter((e) => e.receivedAt > oldest);
  }
}
