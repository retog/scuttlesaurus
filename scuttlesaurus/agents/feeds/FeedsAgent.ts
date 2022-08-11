  import type RpcConnection from "../../comm/rpc/RpcConnection.ts";
import type { RpcContext } from "../../comm/rpc/types.ts";
import {
  Address,
  delay,
  FeedId,
  JSONValue,
  NotFoundError,
  ObservableSet,
  parseFeedId,
  TSEMap,
} from "../../util.ts";
import Agent from "../Agent.ts";
import type FeedsStorage from "../../storage/FeedsStorage.ts";
import type ConnectionManager from "../ConnectionManager.ts";
import RankingTable from "./RankingTable.ts";
import type SubscriptionsAndPeersStorage from "../../storage/SubscriptionsAndPeersStorage.ts";
import { FeedsConnection } from "./FeedsConnection.ts";

export type MessageValue = JSONValue & {
  sequence: number;
  author: string;
  signature: string;
  previous: string | null;
  content: JSONValue;
};

export type Message = {
  value: MessageValue;
  key: string;
};
/**
 * This creates a FeedsConnection for every new RpcConnection. On a FeedsConnection it requests Feeds as per the recommandations provided by RankingTable.getFolloweeFor.
 *
 * It regularly asks RankingTable for recommendations and creates an RpcConnection to the recommended Address if there's no current connection to the address' peer, else it asks for the feed on every existing FeedsConnection to the address' peer.
 */
export default class FeedsAgent extends Agent {
  rankingTable: RankingTable | undefined;
   subscriptions: ObservableSet<FeedId>;
   peers: ObservableSet<Address>;
  constructor(
    public feedsStorage: FeedsStorage,
    public subscriptionsAndPeersStorage: SubscriptionsAndPeersStorage,
  ) {
    super();
    this.subscriptions = subscriptionsAndPeersStorage.subscriptions
    this.peers = subscriptionsAndPeersStorage.peers
  }

  rpc2FeedsConnections = new WeakMap<RpcConnection, FeedsConnection>();
  peer2FeedsConnections = new TSEMap<FeedId, FeedsConnection[]>();

  createRpcContext(_feedId: FeedId): RpcContext {
    // deno-lint-ignore no-this-alias
    const agent = this;
    return {
      createHistoryStream: async function* (args: Record<string, string>[]) {
        const opts = args[0];
        const feedId = parseFeedId(opts.id);
        const live = (typeof (opts.live) === "undefined")
          ? false
          : JSON.parse(opts.live);
        const old = (typeof (opts.old) === "undefined")
          ? true
          : JSON.parse(opts.old);
        const keys = (typeof (opts.keys) === "undefined")
          ? true
          : JSON.parse(opts.keys);
        const seq = (typeof (opts.sequence) === "undefined")
          ? (typeof (opts.seq) === "undefined") ? 1 : Number.parseInt(opts.seq)
          : Number.parseInt(opts.sequence);
        for await (
          const msg of agent.getFeed(feedId, {
            fromMessage: old ? seq : 0,
            newMessages: live,
          })
        ) {
          if (keys) {
            yield msg;
          } else {
            yield msg.value;
          }
        }
      },
    };
  }

  //private onGoingSyncPeers = new TSEMap<FeedId, RpcConnection>();

  private getFeedsConnection(
    rpcConnection: RpcConnection,
    opts?: { signal?: AbortSignal; newMessageTimeout?: number },
  ): FeedsConnection {
    const cachedFeedsConnection = this.rpc2FeedsConnections.get(rpcConnection);
    if (
      cachedFeedsConnection &&
      !cachedFeedsConnection.rpcConnection.boxConnection.closed
    ) {
      return cachedFeedsConnection;
    }
    const newFeedsConnection = new FeedsConnection(rpcConnection, opts);
    this.rpc2FeedsConnections.set(rpcConnection, newFeedsConnection);
    const peer = rpcConnection.boxConnection.peer;
    const connectionsToPeer = this.peer2FeedsConnections.get(peer) ?? [];
    connectionsToPeer.push(newFeedsConnection);
    this.peer2FeedsConnections.set(
      peer,
      connectionsToPeer.filter((c) => !c.rpcConnection.boxConnection.closed),
    );
    return newFeedsConnection;
  }

  async incomingConnection(
    rpcConnection: RpcConnection,
    opts?: { signal?: AbortSignal },
  ) {
    if (!this.rankingTable) {
      this.rankingTable = new RankingTable(
        { peers: this.peers, followees: this.subscriptions },
        this.subscriptionsAndPeersStorage,
        opts,
      );
    }
    const feedsConnection = this.getFeedsConnection(rpcConnection, {
      signal: opts?.signal,
      newMessageTimeout: 24 * 60 * 60 * 1000,
    });
    this.syncFeed(feedsConnection, rpcConnection.boxConnection.peer);

    await this.outgoingConnection(rpcConnection, opts);
  }
  async syncFeed(
    feedsConnection: FeedsConnection,
    feedId: FeedId,
    opts?: { signal?: AbortSignal },
  ) {
    await feedsConnection.syncFeed(
      feedId,
      this.feedsStorage,
      (f: FeedId, m: Message) => {
        this.fireNewMessageEvent(f, m);
        this.rankingTable!.recordSuccess(
          feedsConnection.rpcConnection.boxConnection.peer,
          f,
        );
      },
      opts,
    );
  }

  async outgoingConnection(
    rpcConnection: RpcConnection,
    opts?: { signal?: AbortSignal },
  ) {
    if (!this.rankingTable) {
      this.rankingTable = new RankingTable(
        { peers: this.peers, followees: this.subscriptions },
        this.subscriptionsAndPeersStorage,
        opts,
      );
    }
    const feedsConnection = this.getFeedsConnection(rpcConnection, {
      signal: opts?.signal,
      newMessageTimeout: 2 * 60 * 1000,
    });
    await this.updateFeeds(feedsConnection, opts);
  }

  async run(
    connector: ConnectionManager,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    if (!this.rankingTable) {
      this.rankingTable = new RankingTable(
        { peers: this.peers, followees: this.subscriptions },
        this.subscriptionsAndPeersStorage,
        opts,
      );
    }
    const onGoingConnectionAttempts = new Set<string>();
    this.subscriptions.addAddListener(async (feedId) => {
      for (
        const connection of [...this.peer2FeedsConnections.values()].flat(1)
      ) {
        await this.syncFeed(connection, feedId, { signal: opts?.signal });
      }
    });
    while (true) {
      if (opts?.signal?.aborted) {
        throw new DOMException("FeedsAgent was aborted.", "AbortError");
      }
      if (onGoingConnectionAttempts.size >= this.peers.size) {
        try {
          await delay(2000, opts);
        } catch (_error) {
          //aborted
          break;
        }
      }
      const recommendation = await this.rankingTable.getRecommendation();
      console.debug(
        `Following recommendation: ${JSON.stringify(recommendation)}`,
      );
      const feedsConnections = (this.peer2FeedsConnections.get(
        recommendation.peer.key,
      ) ?? []).filter((c) => !c.rpcConnection.boxConnection.closed);
      if (feedsConnections.length > 0) {
        feedsConnections.forEach((c) =>
          this.syncFeed(c, recommendation.followee, opts).catch(console.error)
        );
      } else {
        const pickedPeer = recommendation.peer;
        const pickedPeerStr = pickedPeer.key.base64Key;
        if (!onGoingConnectionAttempts.has(pickedPeerStr)) {
          onGoingConnectionAttempts.add(pickedPeerStr);
          (async () => {
            try {
              //this will cause `outgoingConnection` to be invoked
              const rpcConnection = await connector.getConnectionWith(
                pickedPeer,
              );
              const feedsConnection = this.getFeedsConnection(rpcConnection, {
                signal: opts?.signal,
                newMessageTimeout: 2 * 60 * 1000,
              });
              this.syncFeed(feedsConnection, recommendation.followee, opts)
                .catch(console.error);
            } catch (error) {
              console.error(
                `In connection with ${pickedPeer}: ${error.stack}`,
              );
              if (error.errors) {
                error.errors.forEach(console.info);
              }
              //TODO this shoul cause this peer to be attempted less frequently
            }
          })().finally(() => {
            onGoingConnectionAttempts.delete(pickedPeerStr);
          });
        }
      }
      try {
        await delay(1000, opts);
      } catch (_error) {
        //aborted
      }
    }
  }

  private newMessageListeners: Array<(feedId: FeedId, msg: Message) => void> =
    [];

  addNewMessageListeners(listener: (feedId: FeedId, msg: Message) => void) {
    this.newMessageListeners.push(listener);
  }

  removeNewMessageListeners(listener: (feedId: FeedId, msg: Message) => void) {
    this.newMessageListeners.splice(
      this.newMessageListeners.indexOf(listener),
      1,
    );
  }

  fireNewMessageEvent(feedKey: FeedId, msg: Message) {
    this.newMessageListeners.forEach((listener) => listener(feedKey, msg));
  }

  async *getFeed(feedId: FeedId, {
    /** negative numbers are relative to the latest message, 0 means no existing message,
     * positive numbers indicate the index of the oldest message to be returned */
    fromMessage = -10,
    newMessages = true,
  }: { fromMessage?: number; newMessages?: boolean } = {}): AsyncIterable<
    Message
  > {
    if (fromMessage != 0) {
      const lastMessage = await this.feedsStorage.lastMessage(feedId);
      fromMessage = fromMessage > 0
        ? fromMessage
        : lastMessage + fromMessage + 1;
      if (fromMessage < 1) {
        fromMessage = 1;
      }
      for (let pos = fromMessage; pos <= lastMessage; pos++) {
        try {
          yield this.feedsStorage.getMessage(
            feedId,
            pos,
          );
        } catch (error) {
          if (error instanceof NotFoundError) {
            console.info(
              `Message ${pos} of ${feedId} not found`,
            );
          }
        }
      }
    }
    if (newMessages && this.subscriptions.has(feedId)) {
      let resolver: (msg: Message) => void;
      const listener = (
        msgFeedId: FeedId,
        msg: Message,
      ) => {
        if (feedId.base64Key === msgFeedId.base64Key) {
          if (msg.value.sequence >= fromMessage) {
            resolver(msg);
          }
        }
      };
      this.addNewMessageListeners(listener);
      try {
        while (true) {
          yield await new Promise<Message>((resolve) => {
            resolver = resolve;
          });
        }
      } finally {
        this.removeNewMessageListeners(listener);
      }
    }
  }

  private async updateFeeds(
    feedsConnection: FeedsConnection,
    opts?: { signal?: AbortSignal },
  ) {
    const subscriptions = await this.rankingTable!.getFolloweesFor(
      feedsConnection.rpcConnection.boxConnection.peer,
      50,
    );
    await Promise.all(
      [...subscriptions].map((feed) =>
        this.syncFeed(feedsConnection, feed, opts)
      ),
    );
  }
}
