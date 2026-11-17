/**
 * The NIP-01 relay served to clients. Contract: `docs/ARCHITECTURE.md`.
 *
 * Implements NIP-01 (EVENT, REQ, CLOSE and the OK, EOSE, CLOSED, NOTICE
 * replies), NIP-11 (relay information) and NIP-45 (COUNT). Clients may only
 * publish events from authors within the social graph of the owner.
 * @module
 */
import type {
  Config,
  EventStore,
  NostrEvent,
  RelayServer,
  SocialGraph,
} from "../types.ts";
import { ClientConnection } from "./connection.ts";
import { relayInformation } from "./nip11.ts";
import { clientAddress } from "../client_address.ts";
import { ClientLimitsTable } from "./client_limits.ts";
import { ReplayBuffer } from "./replay_buffer.ts";

export interface RelayServerOptions {
  events: EventStore;
  graph: SocialGraph;
  config: Config;
  /** Called for every event a client published and the relay accepted. */
  onAccepted?: (event: NostrEvent) => void;
}

/**
 * Creates the relay. It registers one listener on the event store, which fans
 * every accepted event out to the subscriptions of all connections (NIP-01).
 *
 * @param options The store, the social graph and the live configuration.
 * @returns The relay: WebSocket upgrades (NIP-01), NIP-11 information, and
 *   shutdown.
 */
export function createRelayServer(options: RelayServerOptions): RelayServer {
  const connections = new Set<ClientConnection>();
  let closed = false;
  const replay = new ReplayBuffer();
  const limits = new ClientLimitsTable();

  const unsubscribe = options.events.subscribe((event) => {
    for (const connection of [...connections]) connection.deliver(event);
  });

  return {
    handleUpgrade(request: Request): Response {
      if (closed) {
        return new Response("the relay is shut down", { status: 503 });
      }
      const allowance = limits.admit(clientAddress(request));
      if (!allowance) {
        return new Response("too many connections from this address", {
          status: 429,
        });
      }
      let upgrade: ReturnType<typeof Deno.upgradeWebSocket>;
      try {
        upgrade = Deno.upgradeWebSocket(request);
      } catch {
        limits.release(allowance);
        return new Response("expected a WebSocket upgrade", { status: 400 });
      }
      const connection = new ClientConnection(
        upgrade.socket,
        options,
        (gone) => {
          connections.delete(gone);
          limits.release(allowance);
        },
        replay,
        allowance,
      );
      connections.add(connection);
      return upgrade.response;
    },

    info(_request: Request): Response {
      return relayInformation(options.config);
    },

    connections(): number {
      return connections.size;
    },

    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const connection of [...connections]) {
        connection.close(1001, "relay closed");
      }
      connections.clear();
    },
  };
}
