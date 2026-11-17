/**
 * What one client address may do on the relay at the same time, shared by all
 * its connections: how many connections it holds, how many Nostr Connect
 * recipients it asks the replay buffer to keep, and how fast it may send
 * Nostr Connect events from outside the graph.
 *
 * A limit per connection is no limit, since a client can open more
 * connections; a limit per address at least makes a flood need many
 * addresses. See `src/client_address.ts` for what an address is.
 *
 * @module
 */
import { UNKNOWN_CLIENT } from "../client_address.ts";
import { NOSTR_CONNECT_BURST, NOSTR_CONNECT_PER_SECOND } from "./protocol.ts";

/** Most simultaneous connections from one address. */
export const MAX_CONNECTIONS_PER_CLIENT = 20;
/** Most Nostr Connect recipients one address can ask the buffer to keep. */
export const MAX_WATCHED_PER_CLIENT = 32;

/** The shared allowance of one client address. */
export class ClientLimits {
  /** Open connections. */
  connections = 0;
  /** Recipients its connections currently watch. */
  watched = 0;
  #tokens = NOSTR_CONNECT_BURST;
  #refilled: number;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#refilled = now();
  }

  /** Whether one more Nostr Connect event may be sent now (token bucket). */
  takeConnectToken(): boolean {
    const now = this.#now();
    this.#tokens = Math.min(
      NOSTR_CONNECT_BURST,
      this.#tokens + (now - this.#refilled) / 1000 * NOSTR_CONNECT_PER_SECOND,
    );
    this.#refilled = now;
    if (this.#tokens < 1) return false;
    this.#tokens--;
    return true;
  }

  /** Whether the bucket is full again, so the entry can be forgotten. */
  get idle(): boolean {
    return this.connections === 0 && this.watched === 0 &&
      this.#now() - this.#refilled >
        NOSTR_CONNECT_BURST / NOSTR_CONNECT_PER_SECOND * 1000;
  }
}

/** The limits of every address that has, or recently had, a connection. */
export class ClientLimitsTable {
  readonly #byAddress = new Map<string, ClientLimits>();

  /**
   * The limits for a new connection from `address`, or `undefined` when the
   * address already holds {@link MAX_CONNECTIONS_PER_CLIENT}. Call
   * {@link release} when the connection ends. An unknown address (a handler
   * called without connection information) gets limits of its own.
   */
  admit(address: string): ClientLimits | undefined {
    if (address === UNKNOWN_CLIENT) {
      const own = new ClientLimits();
      own.connections = 1;
      return own;
    }
    this.#forgetIdle();
    let limits = this.#byAddress.get(address);
    if (!limits) {
      limits = new ClientLimits();
      this.#byAddress.set(address, limits);
    }
    if (limits.connections >= MAX_CONNECTIONS_PER_CLIENT) return undefined;
    limits.connections++;
    return limits;
  }

  /** A connection admitted with these limits has ended. */
  release(limits: ClientLimits): void {
    limits.connections = Math.max(0, limits.connections - 1);
  }

  /** Number of addresses remembered. */
  get size(): number {
    return this.#byAddress.size;
  }

  #forgetIdle(): void {
    if (this.#byAddress.size < 1000) return;
    for (const [address, limits] of this.#byAddress) {
      if (limits.idle) this.#byAddress.delete(address);
    }
  }
}
