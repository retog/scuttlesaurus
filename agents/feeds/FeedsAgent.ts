import RpcConnection from "../../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../../comm/rpc/types.ts";
import {
  Address,
  computeMsgHash,
  delay,
  FeedId,
  JSONValue,
  log,
  parseAddress,
  parseFeedId,
  path,
  toBase64,
  verifySignature,
} from "../../util.ts";
import Agent from "../Agent.ts";
import FeedsStorage from "../../storage/FeedsStorage.ts";

export default class FeedsAgent extends Agent {
  followeesFile: string;
  subscriptions: string[];
  constructor(public feedsStorage: FeedsStorage, public baseDir: string) {
    super();

    this.followeesFile = path.join(this.baseDir, "followees.json");

    try {
      this.subscriptions = JSON.parse(
        Deno.readTextFileSync(this.followeesFile),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        this.subscriptions = [];
      } else {
        throw error;
      }
    }
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
            if (error instanceof Deno.errors.NotFound) {
              log.debug(`Message ${seq} of ${feedKey} not found`);
            }
          }
        }
      },
    };
    return rpcMethods;
  }
  async incomingConnection(rpcConnection: RpcConnection) {
    await this.updateFeeds(rpcConnection);
  }

  outgoingConnection = this.incomingConnection;

  async run(connector: {
    connect(address: Address): Promise<RpcConnection>;
  }): Promise<void> {
    const peersFile = path.join(this.baseDir, "peers.json");

    function getPeersFromFile() {
      try {
        return JSON.parse(Deno.readTextFileSync(peersFile));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return [];
        }
        throw error;
      }
    }

    function getPeers() {
      return getPeersFromFile().map(parseAddress);
    }

    const peers: Address[] = getPeers();

    let initialDelaySec = 0;
    let onGoingSyncs = 0;
    await Promise.all(peers.map((address) =>
      (async () => {
        initialDelaySec += 10;
        await delay(initialDelaySec * 1000);
        let minutesDelay = 1;
        while (true) {
          if (onGoingSyncs > 20) {
            log.info("More than 20 connections open, standing by.");
          } else {
            log.info(
              `${onGoingSyncs} connections open, connecting to ${address}`,
            );
            onGoingSyncs++;
            try {
              const rpcConnection = await connector.connect(address);
              await this.updateFeeds(rpcConnection);
            } catch (error) {
              log.error(
                `In connection with ${address}: ${error}, now having ${
                  onGoingSyncs -
                  1
                } connections left`,
              );
              log.debug(`stack: ${error.stack}`);
              minutesDelay++;
            }
            onGoingSyncs--;
          }
          await delay(minutesDelay * 60 * 1000);
        }
      })()
    ));
  }

  async updateFeed(
    rpcConnection: RpcConnection,
    feedKey: FeedId,
  ) {
    const messagesAlreadyHere = await this.feedsStorage.lastMessage(feedKey);
    try {
      await this.updateFeedFrom(
        rpcConnection,
        feedKey,
        messagesAlreadyHere > 0 ? messagesAlreadyHere : 1,
      );
    } catch (error) {
      log.info(`error updating feed ${feedKey}: ${error}`);
    }
  }

  async updateFeedFrom(
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
    }) as AsyncIterable<{
      value: JSONValue;
      key: string;
    }>;
    for await (const msg of historyStream) {
      const hash = computeMsgHash(msg.value);
      const key = `%${toBase64(hash)}.sha256`;
      if (key !== msg.key) {
        throw new Error(
          "Computed hash doesn't match key " +
            JSON.stringify(msg, undefined, 2),
        );
      }
      if (
        !verifySignature(msg.value as { author: string; signature: string })
      ) {
        throw Error(
          `failed to verify signature of the message: ${
            JSON.stringify(msg.value, undefined, 2)
          }`,
        );
      }
      //TODO verify that msg.value.previous is correct
      await this.feedsStorage.storeMessage(
        feedKey,
        (msg as { value: { sequence?: number } }).value!.sequence!,
        msg,
      );
    }
    log.debug(() => `Stream ended for feed ${feedKey}`);
  }

  updateFeeds(rpcConnection: RpcConnection) {
    const subscriptions = this.subscriptions;
    return Promise.all(
      subscriptions.map((feed) =>
        this.updateFeed(rpcConnection, parseFeedId(feed))
      ),
    );
  }
}
