/**
 * The way events enter the store: an event whose id is already known is
 * skipped before its signature is looked at (NIP-01), every other event is
 * verified exactly once and stored with the relay it came from as provenance.
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

/** What became of an event offered to {@link Ingest.handle}. */
export type IngestOutcome = "stored" | "known" | "invalid" | "rejected";

/** Verifies and stores events received from relays. */
export class Ingest {
  readonly #events: EventStore;
  readonly #inFlight = new Set<string>();
  readonly #running = new Set<Promise<unknown>>();

  constructor(events: EventStore) {
    this.#events = events;
  }

  /**
   * Store an event received from `relay` unless it is already known.
   * Never rejects.
   */
  handle(relay: string, event: NostrEvent): Promise<IngestOutcome> {
    // The same event often arrives from two relays at once; the in-flight set
    // makes sure only the first is verified.
    if (this.#events.has(event.id) || this.#inFlight.has(event.id)) {
      return Promise.resolve("known");
    }
    this.#inFlight.add(event.id);
    const work = this.#store(relay, event).finally(() => {
      this.#inFlight.delete(event.id);
      this.#running.delete(work);
    });
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
      return "rejected";
    }
  }
}
