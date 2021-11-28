import RpcConnection from "../../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../../comm/rpc/types.ts";
import {
  Address,
  computeMsgHash,
  delay,
  FeedId,
  JSONValue,
  log,
  NotFoundError,
  parseFeedId,
  toBase64,
  verifySignature,
} from "../../util.ts";
import Agent from "../Agent.ts";
import FeedsStorage from "../../storage/FeedsStorage.ts";
import ConnectionManager from "../ConnectionManager.ts";

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
  constructor(
    public feedsStorage: FeedsStorage,
    public subscriptions: FeedId[] = [],
    public peers: Address[] = [],
  ) {
    super();
  }

  createRpcContext(_feedId: FeedId): RpcContext {
    const fsStorage = this.feedsStorage;
    const rpcMethods = {
      createHistoryStream: async function* (args: Record<string, string>[]) {
        const opts = args[0];
        const feedKey = parseFeedId(opts.id);
        let seq = Number.parseInt(opts.seq);
        //log.info(`got request for ${feedKey} with seq: ${seq}`);
        //console.log(`"@${feedKey}.ed25519",`)
        const lastMessage = await fsStorage.lastMessage(feedKey);
        while (seq <= lastMessage) {
          try {
            const parsedFile = await fsStorage.getMessage(feedKey, seq++);
            if (opts.keys === undefined || opts.keys) {
              yield parsedFile as JSONValue | Uint8Array;
            } else {
              yield parsedFile.value as
                | JSONValue
                | Uint8Array;
            }
          } catch (error) {
            if (error instanceof NotFoundError) {
              log.debug(`Message ${seq} of ${feedKey} not found`);
            }
          }
        }
      },
    };
    return rpcMethods;
  }

  /** contains the adress strings of ongoing sync partners */
  private onGoingSyncPeers = new Set<string>();

  async incomingConnection(rpcConnection: RpcConnection) {
    const peerStr = rpcConnection.boxConnection.peer.base64Key;
    if (!this.onGoingSyncPeers.has(peerStr)) {
      this.onGoingSyncPeers.add(peerStr);
      try {
        await this.updateFeeds(rpcConnection);
      } finally {
        this.onGoingSyncPeers.delete(peerStr);
      }
    }
  }

  outgoingConnection = this.incomingConnection;

  private pickPeer(): Address {
    //The maximum is exclusive and the minimum is inclusive
    function getRandomInt(min: number, max: number) {
      return Math.floor(Math.random() * (max - min) + min);
    }
    return this.peers[getRandomInt(0, this.peers.length)];
  }

  async run(connector: ConnectionManager): Promise<void> {
    const onGoingVonnectionAttempts = new Set<string>();
    while (true) {
      const pickedPeer = this.pickPeer();
      const pickedPeerStr = pickedPeer.key.base64Key;
      if (!onGoingVonnectionAttempts.has(pickedPeerStr)) {
        onGoingVonnectionAttempts.add(pickedPeerStr);
        (async () => {
          try {
            //this will cause `outgoingConnection` to be invoked
            await connector.getConnectionWith(pickedPeer);
          } catch (error) {
            log.error(
              `In connection with ${pickedPeer}: ${error}`,
            );
            //TODO this shoul cause this peer to be attempted less frequently
          }
        })().finally(() => {
          onGoingVonnectionAttempts.delete(pickedPeerStr);
        });
      }
      // wait some time depending on how many syncs are going on
      await delay((this.onGoingSyncPeers.size * 10 + 1) * 1000);
    }
  }

  private newMessageListeners: Array<(feedId: FeedId, msg: Message) => void> =
    [];

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
    if (newMessages) {
      while (true) {
        let listenerPos = -1;
        yield await new Promise<Message>((resolve) => {
          listenerPos = this.newMessageListeners.length;
          this.newMessageListeners[listenerPos] = (
            msgFeedId: FeedId,
            msg: Message,
          ) => {
            if (feedId.base64Key === msgFeedId.base64Key) {
              resolve(msg);
            }
          };
        });
        this.newMessageListeners.splice(listenerPos, 1);
      }
    }
  }

  private async updateFeed(
    rpcConnection: RpcConnection,
    feedKey: FeedId,
  ) {
    const messagesAlreadyHere = await this.feedsStorage.lastMessage(feedKey);
    try {
      await this.updateFeedFrom(
        rpcConnection,
        feedKey,
        messagesAlreadyHere + 1,
      );
    } catch (error) {
      log.info(`error updating feed ${feedKey}: ${error}`);
    }
  }

  private async updateFeedFrom(
    rpcConnection: RpcConnection,
    feedKey: FeedId,
    from: number,
  ) {
    log.debug(`Updating Feed ${feedKey} from ${from}`);
    const historyStream = await rpcConnection.sendSourceRequest({
      "name": ["createHistoryStream"],
      "args": [{
        "id": feedKey.toString(),
        "seq": from,
      }],
    }) as AsyncIterable<Message>;
    let expectedSequence = from;
    for await (const msg of historyStream) {
      if (expectedSequence !== msg.value.sequence) {
        throw new Error(
          `Expected sequence ${expectedSequence} but got ${msg.value.sequence}`,
        );
      }
      expectedSequence++;
      const hash = computeMsgHash(msg.value);
      const key = `%${toBase64(hash)}.sha256`;
      if (key !== msg.key) {
        throw new Error(
          "Computed hash doesn't match key " +
            JSON.stringify(msg, undefined, 2),
        );
      }
      if (
        !verifySignature(msg.value)
      ) {
        throw Error(
          `failed to verify signature of the message: ${
            JSON.stringify(msg.value, undefined, 2)
          }`,
        );
      }
      if (msg.value.sequence > 1) {
        const previousMessage = await this.feedsStorage.getMessage(
          feedKey,
          msg.value.sequence - 1,
        );
        if (previousMessage.key !== msg.value.previous) {
          throw new Error(
            `Broken Crypto-Chain in ${feedKey} at ${msg.value.sequence}`,
          );
        }
      }

      try {
        await this.feedsStorage.storeMessage(
          feedKey,
          msg.value.sequence,
          msg,
        );
        this.newMessageListeners.forEach((listener) => listener(feedKey, msg));
      } catch (e) {
        log.debug(`Storing message: ${e}`);
      }
    }
    log.debug(() => `Stream ended for feed ${feedKey}`);
  }

  private updateFeeds(rpcConnection: RpcConnection) {
    const subscriptions = this.subscriptions;
    return Promise.all(
      subscriptions.map((feed) => this.updateFeed(rpcConnection, feed)),
    );
  }
}
