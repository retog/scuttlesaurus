/**
 * Signed events whose publication the relay never confirmed. When the person
 * sends the same thing again, the same signed event is sent again instead of
 * a newly signed one: the relay answers a duplicate with `OK true`, so a retry
 * can never make a second post (with its own id) out of one.
 *
 * @module
 */
import type { Event, EventTemplate } from "@nostr/tools/core";

/** How long an unconfirmed event is offered for a retry (default 1 hour). */
const KEEP_MS = 60 * 60_000;
/** Most events remembered; the oldest is dropped beyond this. */
const MAX_KEPT = 50;

/** What makes two publications "the same thing": everything but the time. */
function keyOf(
  pubkey: string,
  { kind, content, tags }: Pick<EventTemplate, "kind" | "content" | "tags">,
): string {
  return JSON.stringify([pubkey, kind, content, tags]);
}

/** The unconfirmed events of this page, by what they say. */
export class UnconfirmedEvents {
  readonly #kept = new Map<string, { event: Event; at: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The unconfirmed event of `pubkey` that says what `template` says. */
  find(pubkey: string, template: EventTemplate): Event | undefined {
    const key = keyOf(pubkey, template);
    const kept = this.#kept.get(key);
    if (!kept) return undefined;
    if (this.#now() - kept.at > KEEP_MS) {
      this.#kept.delete(key);
      return undefined;
    }
    return kept.event;
  }

  /** Remember an event the relay did not confirm. */
  keep(event: Event): void {
    const key = keyOf(event.pubkey, event);
    this.#kept.delete(key);
    this.#kept.set(key, { event, at: this.#now() });
    while (this.#kept.size > MAX_KEPT) {
      this.#kept.delete(this.#kept.keys().next().value!);
    }
  }

  /** Forget an event: the relay has answered for it. */
  forget(event: Event): void {
    const key = keyOf(event.pubkey, event);
    if (this.#kept.get(key)?.event.id === event.id) this.#kept.delete(key);
  }
}
