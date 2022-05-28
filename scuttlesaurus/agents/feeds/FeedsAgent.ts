import type RpcConnection from "../../comm/rpc/RpcConnection.ts";
import type { RpcContext } from "../../comm/rpc/types.ts";
import {
  Address,
  delay,
  FeedId,
  JSONValue,
  log,
  NotFoundError,
  ObservableSet,
  parseFeedId,
  TSEMap,
} from "../../util.ts";
import Agent from "../Agent.ts";
import type FeedsStorage from "../../storage/FeedsStorage.ts";
import type ConnectionManager from "../ConnectionManager.ts";
import RankingTable from "./RankingTable.ts";
import type RankingTableStorage from "../../storage/RankingTableStorage.ts";
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

export default class FeedsAgent extends Agent {
  rankingTable: RankingTable;
  constructor(
    public feedsStorage: FeedsStorage,
    public rankingTableStorage: RankingTableStorage,
    public subscriptions: ObservableSet<FeedId>,
    public peers: ObservableSet<Address>,
  ) {
    super();
    this.rankingTable = new RankingTable(
      { peers, followees: subscriptions },
      rankingTableStorage,
    );
  }

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

  private onGoingSyncPeers = new TSEMap<FeedId, RpcConnection>();

  async incomingConnection(
    rpcConnection: RpcConnection,
    opts?: { signal?: AbortSignal },
  ) {
    this.updateFeed(
      rpcConnection,
      rpcConnection.boxConnection.peer,
      { signal: opts?.signal },
    );
    await this.outgoingConnection(rpcConnection, opts);
  }

  async outgoingConnection(
    rpcConnection: RpcConnection,
    opts?: { signal?: AbortSignal },
  ) {
    const peer = rpcConnection.boxConnection.peer;
    if (!this.onGoingSyncPeers.has(peer)) {
      this.onGoingSyncPeers.set(peer, rpcConnection);
      try {
        await this.updateFeeds(rpcConnection, opts);
      } finally {
        this.onGoingSyncPeers.delete(peer);
      }
    }
  }

  async run(
    connector: ConnectionManager,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const onGoingConnectionAttempts = new Set<string>();
    this.subscriptions.addAddListener(async (feedId) => {
      for (const connection of this.onGoingSyncPeers.values()) {
        await this.updateFeed(connection, feedId, { signal: opts?.signal });
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
      const recommendation = await this.rankingTable.getRecommendation(
        opts?.signal,
      );
      const pickedPeer = recommendation.peer;
      const pickedPeerStr = pickedPeer.key.base64Key;
      if (!onGoingConnectionAttempts.has(pickedPeerStr)) {
        onGoingConnectionAttempts.add(pickedPeerStr);
        (async () => {
          try {
            //this will cause `outgoingConnection` to be invoked
            const rpcConnection = await connector.getConnectionWith(pickedPeer);
            this.updateFeed(
              rpcConnection,
              recommendation.followee,
              opts,
            );
          } catch (error) {
            log.error(
              `In connection with ${pickedPeer}: ${error.stack}`,
            );
            if (error.errors) {
              error.errors.forEach(log.info);
            }
            //TODO this shoul cause this peer to be attempted less frequently
          }
        })().finally(() => {
          onGoingConnectionAttempts.delete(pickedPeerStr);
        });
        // wait some time depending on how many syncs are going on
        try {
          await delay((this.onGoingSyncPeers.size * 1 + 1) * 1000, opts);
        } catch (_error) {
          //aborted
        }
        if (opts?.signal?.aborted) {
          for (const conn of this.onGoingSyncPeers.values()) {
            console.warn("closing connection after abort");
            conn.boxConnection.close();
          }
        }
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
            log.info(
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

  async updateFeed(
    rpcConnection: RpcConnection,
    feedKey: FeedId,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const feedsConnection = new FeedsConnection(rpcConnection, {
      signal: opts?.signal,
      newMessageTimeout: 2 * 60 * 1000,
    });
    try {
      await feedsConnection.syncFeed(
        feedKey,
        this.feedsStorage,
        (f: FeedId, m: Message) => {
          this.fireNewMessageEvent(f, m);
          this.rankingTable.recordSuccess(
            rpcConnection.boxConnection.peer,
            f,
            opts?.signal,
          );
        },
        opts,
      );
    } catch (error) {
      log.info(`error updating feed ${feedKey}: ${error}`);
    }
  }

  private async updateFeeds(
    rpcConnection: RpcConnection,
    opts?: { signal?: AbortSignal },
  ) {
    const subscriptions = await this.rankingTable.getFolloweesFor(
      rpcConnection.boxConnection.peer,
      50,
    );
    await Promise.all(
      [...subscriptions].map((feed) =>
        this.updateFeed(rpcConnection, feed, opts)
      ),
    );
  }
}
