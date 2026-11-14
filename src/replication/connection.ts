/**
 * One outgoing WebSocket to a relay (NIP-01), with reconnection. It speaks the
 * client half of the protocol: `REQ`/`CLOSE` with `EVENT`, `EOSE` and `CLOSED`
 * coming back, and `EVENT` with `OK` for publishing. What to ask and what to do
 * with the answers is decided by the caller; events are handed over unparsed.
 *
 * Failures are retried with exponential backoff. After `maxFailures` in a row
 * the connection gives up and tells its owner, who decides what happens next.
 * @module
 */
import type { Filter, NostrEvent, PublishResult } from "../types.ts";

/** Where a connection is in its life; the same words as `RelayStatus.state`. */
export type ConnectionState = "connecting" | "connected" | "backoff" | "closed";

/** Timings and limits of a connection. */
export interface ConnectionSettings {
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Consecutive failures that make the connection give up. */
  maxFailures: number;
  connectTimeoutMs: number;
  /** A connection that stayed open this long was healthy: failures reset. */
  stableMs: number;
  /** False for a connection that is used once and not repaired. */
  reconnect: boolean;
}

/** Callbacks about the connection as a whole. */
export interface ConnectionHandlers {
  /** The socket opened; subscriptions can be made. */
  onOpen(): void;
  /** The socket failed or closed unexpectedly; every subscription is gone. */
  onLost(error: string): void;
  /** Too many failures in a row; no further attempt will be made. */
  onGiveUp(error: string): void;
}

/** Callbacks about one subscription. */
export interface SubscriptionHandlers {
  /** An `EVENT` message; the payload is unvalidated JSON. */
  onEvent(event: unknown): void;
  /** `EOSE`: stored events are exhausted. */
  onEose(): void;
  /** The relay sent `CLOSED`, or the connection was lost. */
  onClosed(reason: string): void;
}

/** An open subscription. */
export interface Subscription {
  /** Send `CLOSE`. No callback follows. */
  close(): void;
}

interface PendingPublish {
  resolve(result: string | undefined): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Wait this long for a close handshake before letting go of a socket. */
const CLOSE_GRACE_MS = 2000;

/** A relay connection that repairs itself. */
export class RelayConnection {
  readonly url: string;
  readonly #settings: ConnectionSettings;
  readonly #handlers: ConnectionHandlers;
  readonly #subscriptions = new Map<string, SubscriptionHandlers>();
  readonly #publishes = new Map<string, PendingPublish>();
  #state: ConnectionState = "closed";
  #socket: WebSocket | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #openedAt = 0;
  #failures = 0;
  #lastError: string | undefined;
  #socketError: string | undefined;
  #counter = 0;
  #stopped = false;
  #started = false;
  #socketClosed: Promise<void> = Promise.resolve();

  constructor(
    url: string,
    settings: ConnectionSettings,
    handlers: ConnectionHandlers,
  ) {
    this.url = url;
    this.#settings = settings;
    this.#handlers = handlers;
  }

  /** Where the connection is now. */
  get state(): ConnectionState {
    return this.#state;
  }

  /** Whether subscriptions and publishing can be used right now. */
  get connected(): boolean {
    return this.#state === "connected";
  }

  /** The most recent failure, kept after the connection recovers. */
  get lastError(): string | undefined {
    return this.#lastError;
  }

  /** Start connecting. Does nothing when already started or closed. */
  connect(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#attempt();
  }

  /**
   * Ask the relay for events (NIP-01 `REQ`).
   *
   * @returns The subscription, or undefined when the connection is not open.
   */
  subscribe(
    filters: Filter[],
    handlers: SubscriptionHandlers,
  ): Subscription | undefined {
    const id = `s${++this.#counter}`;
    if (!this.#send(["REQ", id, ...filters])) return undefined;
    this.#subscriptions.set(id, handlers);
    return {
      close: () => {
        if (this.#subscriptions.delete(id)) this.#send(["CLOSE", id]);
      },
    };
  }

  /**
   * Send an event (NIP-01 `EVENT`) and wait for the relay's `OK`.
   * Never rejects.
   */
  publish(event: NostrEvent, timeoutMs: number): Promise<PublishResult> {
    return new Promise((resolve) => {
      const relay = this.url;
      if (!this.connected || !this.#send(["EVENT", event])) {
        resolve({
          relay,
          ok: false,
          message: `not connected (${this.#state})`,
        });
        return;
      }
      const timer = setTimeout(() => {
        this.#publishes.delete(event.id);
        resolve({ relay, ok: false, message: "timed out waiting for OK" });
      }, timeoutMs);
      this.#publishes.set(event.id, {
        timer,
        resolve: (message) => {
          resolve(
            message === undefined || message.startsWith("duplicate:")
              ? { relay, ok: true, message }
              : { relay, ok: false, message },
          );
        },
      });
    });
  }

  /** Close the socket and cancel every timer. Resolves once the socket is gone. */
  async close(): Promise<void> {
    this.#stopped = true;
    this.#state = "closed";
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#failPending("connection closed");
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Already closing; waiting for the close event below is enough.
      }
    }
    // A peer that never answers the close handshake must not hold us up.
    const grace = Promise.withResolvers<void>();
    const timer = setTimeout(grace.resolve, CLOSE_GRACE_MS);
    await Promise.race([this.#socketClosed, grace.promise]);
    clearTimeout(timer);
  }

  #attempt(): void {
    if (this.#stopped) return;
    this.#state = "connecting";
    this.#socketError = undefined;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.#lost(undefined, describe(error));
      return;
    }
    this.#socket = socket;
    const closed = Promise.withResolvers<void>();
    this.#socketClosed = Promise.all([this.#socketClosed, closed.promise]).then(
      () => {},
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#socketError = "connect timeout";
      try {
        socket.close();
      } catch {
        // Closing a socket that is not open yet may throw; the timeout stands.
      }
      this.#lost(socket, "connect timeout");
    }, this.#settings.connectTimeoutMs);

    socket.onopen = () => {
      if (this.#socket !== socket) return;
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#openedAt = Date.now();
      this.#state = "connected";
      this.#call(() => this.#handlers.onOpen());
    };
    socket.onmessage = (message) => {
      if (this.#socket !== socket) return;
      try {
        this.#message(message.data);
      } catch (error) {
        console.error(`replication: ${this.url}:`, describe(error));
      }
    };
    socket.onerror = (event) => {
      this.#socketError =
        "message" in event && typeof event.message === "string"
          ? event.message
          : "WebSocket error";
    };
    socket.onclose = (event) => {
      closed.resolve();
      if (this.#socket !== socket) return;
      const reason = event.reason ? `: ${event.reason}` : "";
      this.#lost(
        socket,
        this.#socketError ?? `closed (${event.code}${reason})`,
      );
    };
  }

  /** The socket failed to open or went away; schedule the next attempt. */
  #lost(socket: WebSocket | undefined, error: string): void {
    if (this.#stopped) return;
    if (socket !== undefined && this.#socket !== socket) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const wasOpen = this.#state === "connected";
    this.#socket = undefined;
    this.#lastError = error;
    if (wasOpen && Date.now() - this.#openedAt >= this.#settings.stableMs) {
      this.#failures = 0;
    }
    this.#failures++;

    const giveUp = !this.#settings.reconnect ||
      this.#failures >= this.#settings.maxFailures;
    this.#state = giveUp ? "closed" : "backoff";
    // The owner learns of the loss first, so that it can still account for the
    // subscriptions that are about to be failed.
    if (wasOpen) this.#call(() => this.#handlers.onLost(error));
    this.#failPending(error);
    if (giveUp) {
      this.#stopped = true;
      this.#call(() => this.#handlers.onGiveUp(error));
      return;
    }
    const delay = Math.min(
      this.#settings.backoffBaseMs * 2 ** (this.#failures - 1),
      this.#settings.backoffMaxMs,
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#attempt();
    }, delay);
  }

  #failPending(reason: string): void {
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    for (const handlers of subscriptions) {
      this.#call(() => handlers.onClosed(reason));
    }
    const publishes = [...this.#publishes.values()];
    this.#publishes.clear();
    for (const pending of publishes) {
      clearTimeout(pending.timer);
      pending.resolve(reason);
    }
  }

  #message(data: unknown): void {
    if (typeof data !== "string") return;
    const frame: unknown = JSON.parse(data);
    if (!Array.isArray(frame) || typeof frame[0] !== "string") return;
    const [type, first, second, third] = frame;
    switch (type) {
      case "EVENT": {
        const handlers = this.#subscriptions.get(first);
        if (handlers) this.#call(() => handlers.onEvent(second));
        break;
      }
      case "EOSE": {
        const handlers = this.#subscriptions.get(first);
        if (handlers) this.#call(() => handlers.onEose());
        break;
      }
      case "CLOSED": {
        const handlers = this.#subscriptions.get(first);
        this.#subscriptions.delete(first);
        if (handlers) {
          this.#call(() => handlers.onClosed(String(second ?? "closed")));
        }
        break;
      }
      case "OK": {
        const pending = this.#publishes.get(first);
        if (!pending) break;
        this.#publishes.delete(first);
        clearTimeout(pending.timer);
        pending.resolve(
          second === true ? undefined : String(third ?? "rejected"),
        );
        break;
      }
    }
  }

  #send(message: unknown[]): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Run a callback so that its failure cannot break the connection. */
  #call(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error(`replication: ${this.url}:`, describe(error));
    }
  }
}

/** The message of anything that was thrown. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
