import RpcConnection from "../../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../../comm/rpc/types.ts";
import {
  Address,
  delay,
  FeedId,
  log,
  parseAddress,
  parseFeedId,
  path,
} from "../../util.ts";
import Agent from "../Agent.ts";
import * as FsStorage from "../../fsStorage.ts";
import { updateFeeds } from "./feedSubscriptions.ts";
import config from "../../config.ts";

export default class FeedsAgent extends Agent {
  createRpcContext(_feedId: FeedId): RpcContext {
    const rpcMethods = {
      createHistoryStream: async function* (args: Record<string, string>[]) {
        const opts = args[0];
        const feedKey = parseFeedId(opts.id);
        let seq = Number.parseInt(opts.seq);
        //log.info(`got request for ${feedKey} with seq: ${seq}`);
        //console.log(`"@${feedKey}.ed25519",`)
        const lastMessage = await FsStorage.lastMessage(feedKey);
        while (seq < lastMessage) {
          const fileName = path.join(
            FsStorage.getFeedDir(feedKey),
            (seq++) + ".json",
          );
          try {
            const parsedFile = JSON.parse(
              await Deno.readTextFile(fileName),
            );
            if (opts.keys === undefined || opts.keys) {
              yield parsedFile as string | Record<string, unknown> | Uint8Array;
            } else {
              yield parsedFile.value as
                | string
                | Record<string, unknown>
                | Uint8Array;
            }
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
              log.debug(`File ${fileName} not found`);
            }
          }
        }
      },
    };
    return rpcMethods;
  }
  async incomingConnection(rpcConnection: RpcConnection) {
    await updateFeeds(rpcConnection);
  }
  
  outgoingConnection = this.incomingConnection;

  async run(connector: {
    connect(address: Address): Promise<RpcConnection>;
  }): Promise<void> {
    const peersFile = path.join(config.baseDir, "peers.json");

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
              await updateFeeds(rpcConnection);
            } catch (error) {
              log.error(
                `In connection with ${address}: ${error}, now having ${onGoingSyncs} connections left`,
              );
              log.info(`stack: ${error.stack}`);
              minutesDelay++;
            }
            onGoingSyncs--;
          }
          await delay(minutesDelay * 60 * 1000);
        }
      })()
    ));
  }
}
