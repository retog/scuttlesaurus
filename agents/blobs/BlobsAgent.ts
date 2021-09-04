import RpcConnection from "../../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../../comm/rpc/types.ts";
import { BlobId, FeedId, log } from "../../util.ts";
import Agent from "../Agent.ts";

class BlobWant {
  constructor(public blobId: BlobId, public level = -1) {}
}

export default class BlobsAgent extends Agent {
  wantFeeds = new Set<(_: BlobWant) => void>();

  createRpcContext(feedId: FeedId): RpcContext {
    const wantFeeds = this.wantFeeds;
    const rpcMethods = {
      blobs: {
        /*has(args: Record<string, string>[]): Promise<boolean> {
          log.info(`${feedId} asked about ${args}`);
          return Promise.resolve(false);
        },*/
        async *get(args: Record<string, string>[]) {
          log.info(`${feedId} requested ${args}`);
          yield new Uint8Array(0);
        },
        async *createWants(args: Record<string, string>[]) {
          log.info(`${feedId} requested ${args}`);
          yield {};
          wantFeeds.add((_bw: BlobWant) => {/*yield bw */});
        },
      },
    };
    return rpcMethods;
  }
  incomingConnection(_rpcConnection: RpcConnection): Promise<void> {
    throw new Error("Method not implemented.");
  }
  run(): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
