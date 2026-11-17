/**
 * The way events enter the store: an event whose id is already known is never
 * verified again (NIP-01); the store only records the relay it came from as one
 * more `nostr:seenOn`, after checking that it is the event it claims to be.
 * Every other event is verified exactly once and stored with the relay it came
 * from as provenance.
 * @module
 */
import { validateEvent, verifyEvent } from "@nostr/tools/pure";
import type { EventStore, NostrEvent } from "../types.ts";
import { describe } from "./connection.ts";

/**
 * Read an `EVENT` payload from a relay. Only the structure is checked here
 * (NIP-01 field types); the signature is {@link Ingest}'s business.
 */
export function parseEvent(raw: unknown): NostrEvent | undefined {
  if (!validateEvent(raw)) return undefined;
  const { id, sig } = raw as { id?: unknown; sig?: unknown };
  return typeof id === "string" && typeof sig === "string"
    ? raw as NostrEvent
    : undefined;
}

/**
 * What became of an event offered to {@link Ingest.handle}. `error` means the
 * store failed, as opposed to `invalid` and `rejected`, which are verdicts on
 * the event: offering it again later may succeed, so the caller must not treat
 * it as fetched.
 */
export type IngestOutcome =
  | "stored"
  | "known"
  | "invalid"
  | "rejected"
  | "error";

/** Verifies and stores events received from relays. */
export class Ingest {
  readonly #events: EventStore;
  readonly #inFlight = new Map<string, Promise<IngestOutcome>>();
  readonly #running = new Set<Promise<unknown>>();

  constructor(events: EventStore) {
    this.#events = events;
  }

  /**
   * Store an event received from `relay` unless it is already known, in which
   * case only the relay is recorded (`known`). Never rejects.
   */
  handle(relay: string, event: NostrEvent): Promise<IngestOutcome> {
    if (this.#events.has(event.id)) return this.#again(relay, event);
    // The same event often arrives from two relays at once; the in-flight map
    // makes sure only the first is verified. The other one is recorded as a
    // further relay once the first is stored.
    const first = this.#inFlight.get(event.id);
    if (first) {
      return first.then(() =>
        this.#events.has(event.id) ? this.#again(relay, event) : "known"
      );
    }
    const work = this.#store(relay, event).finally(() => {
      this.#inFlight.delete(event.id);
      this.#running.delete(work);
    });
    this.#inFlight.set(event.id, work);
    this.#running.add(work);
    return work;
  }

  /** An event already in the store, offered by another (or the same) relay. */
  #again(relay: string, event: NostrEvent): Promise<IngestOutcome> {
    const work = this.#events.add(event, { seenOn: relay, verified: true })
      .then((result): IngestOutcome =>
        // Not the event it claims to be: its id does not match its fields.
        result.status === "rejected" ? "invalid" : "known"
      )
      .catch((error): IngestOutcome => {
        console.error(
          `replication: could not record a relay:`,
          describe(error),
        );
        return "rejected";
      })
      .finally(() => this.#running.delete(work));
    this.#running.add(work);
    return work;
  }

  /** Resolves when no event is being verified or stored. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  async #store(relay: string, event: NostrEvent): Promise<IngestOutcome> {
    try {
      if (!verifyEvent(event)) return "invalid";
      const result = await this.#events.add(event, {
        seenOn: relay,
        verified: true,
      });
      return result.status === "stored"
        ? "stored"
        : result.status === "rejected"
        ? "rejected"
        : "known";
    } catch (error) {
      console.error(`replication: could not store an event:`, describe(error));
      return "error";
    }
  }
}
