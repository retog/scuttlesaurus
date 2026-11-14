/**
 * Sending an event to the relays of its author (NIP-65 outbox model).
 * @module
 */
import type {
  Config,
  EventStore,
  NostrEvent,
  PublishResult,
} from "../types.ts";
import {
  type ConnectionSettings,
  describe,
  RelayConnection,
} from "./connection.ts";
import type { ResolvedOptions } from "./options.ts";
import { relayUrls } from "./urls.ts";

/** An event is sent to at most this many relays. */
export const MAX_PUBLISH_RELAYS = 8;

/** What {@link publishEvent} needs from the replicator. */
export interface PublishContext {
  events: EventStore;
  config: Config;
  options: ResolvedOptions;
  /** The open connection to a relay, if the replicator has one. */
  openConnection(url: string): RelayConnection | undefined;
}

/**
 * The relays an event by `pubkey` goes to: their write relays (NIP-65), or the
 * bootstrap relays when they have none; at most {@link MAX_PUBLISH_RELAYS}.
 */
export async function publishTargets(
  events: EventStore,
  config: Config,
  pubkey: string,
): Promise<string[]> {
  const lists = await events.relayLists([pubkey]);
  const written = relayUrls(lists.get(pubkey)?.write ?? []);
  const targets = written.length > 0
    ? written
    : relayUrls(config.replication.bootstrapRelays);
  return targets.slice(0, MAX_PUBLISH_RELAYS);
}

/**
 * Send `event` to its author's relays and report per relay. Connections the
 * replicator already holds are reused; for every other relay one is opened for
 * this event alone. Never throws.
 */
export async function publishEvent(
  context: PublishContext,
  event: NostrEvent,
): Promise<PublishResult[]> {
  const { config, options } = context;
  if (!config.replication.enabled) return [];
  let targets: string[];
  try {
    targets = await publishTargets(context.events, config, event.pubkey);
  } catch (error) {
    console.error("replication: could not look up relays:", describe(error));
    return [];
  }
  return await Promise.all(targets.map(async (url): Promise<PublishResult> => {
    try {
      const open = context.openConnection(url);
      return open
        ? await open.publish(event, options.publishTimeoutMs)
        : await publishOnce(url, event, options);
    } catch (error) {
      return { relay: url, ok: false, message: describe(error) };
    }
  }));
}

/** Connect to `url` for this one event, within the publish timeout. */
async function publishOnce(
  url: string,
  event: NostrEvent,
  options: ResolvedOptions,
): Promise<PublishResult> {
  const deadline = Date.now() + options.publishTimeoutMs;
  const settings: ConnectionSettings = {
    backoffBaseMs: options.backoffBaseMs,
    backoffMaxMs: options.backoffMaxMs,
    maxFailures: 1,
    connectTimeoutMs: options.publishTimeoutMs,
    stableMs: options.stableMs,
    reconnect: false,
  };
  const opened = Promise.withResolvers<string | undefined>();
  const connection = new RelayConnection(url, settings, {
    onOpen: () => opened.resolve(undefined),
    onLost: (error) => opened.resolve(error),
    onGiveUp: (error) => opened.resolve(error),
  });
  try {
    connection.connect();
    const failure = await opened.promise;
    if (failure !== undefined) {
      return { relay: url, ok: false, message: failure };
    }
    return await connection.publish(
      event,
      Math.max(1, deadline - Date.now()),
    );
  } finally {
    await connection.close();
  }
}
