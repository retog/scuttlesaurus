/**
 * One client WebSocket. Reads frames and answers `EVENT` (NIP-01 publishing,
 * with the social-graph policy), `REQ` and `CLOSE` (NIP-01 subscriptions) and
 * `COUNT` (NIP-45). Live events reach it through {@link ClientConnection.deliver}.
 * @module
 */
import { matchFilters } from "@nostr/tools/filter";
import type { Filter } from "@nostr/tools/filter";
import type { AddResult, NostrEvent } from "../types.ts";
import type { RelayServerOptions } from "./mod.ts";
import {
  clampLimit,
  errorMessage,
  eventIdOf,
  isSubscriptionId,
  MAX_BUFFERED_BYTES,
  MAX_SUBSCRIPTIONS,
  NOSTR_CONNECT_KIND,
  nostrConnectProblem,
  parseFilters,
  parseFrame,
  parseSignedEvent,
  withMachinePrefix,
} from "./protocol.ts";

/** A REQ subscription on one connection. */
interface Subscription {
  readonly filters: Filter[];
  /**
   * Live events that arrived while the stored query was running. Undefined
   * once the stored events have been sent and the subscription is live.
   */
  buffer: NostrEvent[] | undefined;
}

/**
 * The state and protocol handling of one client connection. Created by the
 * relay for each upgraded WebSocket; reports itself gone through `onGone`.
 */
export class ClientConnection {
  readonly #socket: WebSocket;
  readonly #options: RelayServerOptions;
  readonly #onGone: (connection: ClientConnection) => void;
  readonly #subscriptions = new Map<string, Subscription>();
  #closed = false;

  /**
   * @param socket The upgraded server-side WebSocket.
   * @param options The relay options, read at the time of each use.
   * @param onGone Called once when the connection has ended.
   */
  constructor(
    socket: WebSocket,
    options: RelayServerOptions,
    onGone: (connection: ClientConnection) => void,
  ) {
    this.#socket = socket;
    this.#options = options;
    this.#onGone = onGone;
    socket.onmessage = (event) => this.#onFrame(event.data);
    socket.onclose = () => this.#finish();
    socket.onerror = () => this.#finish();
  }

  /** Whether the connection has ended. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Offers an accepted event to every subscription of this connection that
   * matches it. Subscriptions still loading their stored events buffer it.
   */
  deliver(event: NostrEvent): void {
    if (this.#closed) return;
    for (const [id, subscription] of this.#subscriptions) {
      if (!matchFilters(subscription.filters, event)) continue;
      if (subscription.buffer) {
        subscription.buffer.push(event);
      } else {
        this.#send(["EVENT", id, event]);
      }
    }
  }

  /** Ends the connection, forgetting its subscriptions, and closes the socket. */
  close(code = 1000, reason = ""): void {
    this.#finish();
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close(code, reason);
    }
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscriptions.clear();
    this.#onGone(this);
  }

  #send(message: unknown[]): void {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return;
    if (this.#socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(1008, "slow consumer");
      return;
    }
    this.#socket.send(JSON.stringify(message));
  }

  #notice(message: string): void {
    this.#send(["NOTICE", message]);
  }

  #onFrame(data: unknown): void {
    if (this.#closed) return;
    const frame = parseFrame(data);
    if (!frame.ok) return this.#notice(frame.notice);
    const [type, ...args] = frame.parts;
    switch (type) {
      case "EVENT":
        void this.#publish(args[0]);
        return;
      case "REQ":
        this.#request(frame.parts);
        return;
      case "COUNT":
        void this.#count(frame.parts);
        return;
      case "CLOSE":
        this.#unsubscribe(frame.parts);
        return;
      default:
        this.#notice(`unknown message type ${JSON.stringify(type)}`);
    }
  }

  /** `EVENT` from a client: policy, then storage, then `OK` (NIP-01). */
  async #publish(candidate: unknown): Promise<void> {
    const id = eventIdOf(candidate);
    if (id === undefined) {
      return this.#notice(
        "EVENT needs an event object with a 64-character lowercase hex id",
      );
    }
    const parsed = parseSignedEvent(candidate);
    if ("error" in parsed) {
      return this.#send(["OK", id, false, withMachinePrefix(parsed.error)]);
    }
    const { event } = parsed;
    const { config, events, graph } = this.#options;
    // NIP-46: a signer's key and a client's throwaway key are outside the
    // owner's graph, so a well-formed Nostr Connect event is let through for
    // any author, even before the node has an owner (first-run setup with a
    // signer app). It is ephemeral: relayed, never stored. Anything else, and
    // a malformed 24133 from a member, takes the normal policy below.
    const connectProblem = config.nostrConnect
      ? nostrConnectProblem(event)
      : "disabled";
    if (connectProblem !== undefined) {
      if (config.owner === undefined) {
        return this.#send([
          "OK",
          id,
          false,
          "blocked: this relay has no owner yet",
        ]);
      }
      if (graph.distance(event.pubkey) === undefined) {
        const reason = event.kind === NOSTR_CONNECT_KIND && config.nostrConnect
          ? `invalid: ${connectProblem}`
          : `blocked: author is not within ${config.replication.hops} hops of this relay's owner`;
        return this.#send(["OK", id, false, reason]);
      }
    }

    let result: AddResult;
    try {
      result = await events.add(event, { verified: true });
    } catch (error) {
      return this.#send(["OK", id, false, `error: ${errorMessage(error)}`]);
    }
    switch (result.status) {
      case "stored":
      case "ephemeral":
        this.#send(["OK", id, true, ""]);
        this.#accepted(event);
        return;
      case "duplicate":
        return this.#send([
          "OK",
          id,
          true,
          "duplicate: already have this event",
        ]);
      case "rejected":
        return this.#send([
          "OK",
          id,
          false,
          withMachinePrefix(result.reason || "rejected"),
        ]);
    }
  }

  #accepted(event: NostrEvent): void {
    try {
      this.#options.onAccepted?.(event);
    } catch (error) {
      console.error("relay: onAccepted failed:", errorMessage(error));
    }
  }

  /** `REQ`: registers the subscription, then sends stored events and EOSE. */
  #request(parts: unknown[]): void {
    const id = parts[1];
    if (!isSubscriptionId(id)) {
      return this.#notice(
        "REQ needs a subscription id of 1 to 64 characters",
      );
    }
    const parsed = parseFilters(parts.slice(2));
    if ("error" in parsed) {
      // An invalid REQ also ends any subscription it was meant to replace.
      this.#subscriptions.delete(id);
      return this.#send(["CLOSED", id, `invalid: ${parsed.error}`]);
    }
    if (
      !this.#subscriptions.has(id) &&
      this.#subscriptions.size >= MAX_SUBSCRIPTIONS
    ) {
      return this.#send([
        "CLOSED",
        id,
        "rate-limited: too many subscriptions",
      ]);
    }
    const maxLimit = this.#options.config.maxLimit;
    const filters = parsed.filters.map((filter) =>
      clampLimit(filter, maxLimit)
    );
    void this.#runSubscription(id, filters);
  }

  /**
   * Live events are registered before the stored query starts, so none can
   * fall between the two. Events that arrive meanwhile are buffered, and those
   * the stored query already returned are not sent twice.
   */
  async #runSubscription(id: string, filters: Filter[]): Promise<void> {
    const subscription: Subscription = { filters, buffer: [] };
    this.#subscriptions.set(id, subscription);

    let stored: NostrEvent[];
    try {
      stored = await this.#options.events.query(filters);
    } catch (error) {
      if (this.#subscriptions.get(id) === subscription) {
        this.#subscriptions.delete(id);
        this.#send(["CLOSED", id, `error: ${errorMessage(error)}`]);
      }
      return;
    }
    // Closed, or replaced by a newer REQ with the same id, while querying.
    if (this.#subscriptions.get(id) !== subscription) return;

    const sent = new Set<string>();
    for (const event of stored) {
      this.#send(["EVENT", id, event]);
      sent.add(event.id);
    }
    for (const event of subscription.buffer ?? []) {
      if (!sent.has(event.id)) this.#send(["EVENT", id, event]);
    }
    subscription.buffer = undefined;
    this.#send(["EOSE", id]);
  }

  /** `COUNT` (NIP-45): the number of events the filters match. */
  async #count(parts: unknown[]): Promise<void> {
    const id = parts[1];
    if (!isSubscriptionId(id)) {
      return this.#notice(
        "COUNT needs a subscription id of 1 to 64 characters",
      );
    }
    const parsed = parseFilters(parts.slice(2));
    if ("error" in parsed) {
      return this.#send(["CLOSED", id, `invalid: ${parsed.error}`]);
    }
    try {
      const count = await this.#options.events.count(parsed.filters);
      this.#send(["COUNT", id, { count }]);
    } catch (error) {
      this.#send(["CLOSED", id, `error: ${errorMessage(error)}`]);
    }
  }

  /** `CLOSE`: forgets the subscription. Gets no reply (NIP-01). */
  #unsubscribe(parts: unknown[]): void {
    const id = parts[1];
    if (!isSubscriptionId(id)) {
      return this.#notice(
        "CLOSE needs a subscription id of 1 to 64 characters",
      );
    }
    this.#subscriptions.delete(id);
  }
}
