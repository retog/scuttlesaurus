import RpcConnection from "../../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../../comm/rpc/types.ts";
import { Address, BlobId, FeedId, log } from "../../util.ts";
import Agent from "../Agent.ts";

class BlobWant implements Record<string, unknown> {
  constructor(public blobId: BlobId, public level = -1) {}
  [x: string]: unknown
}
/*
class BlobHas {
  constructor(
    public blobId: BlobId,
    public size: number,
    public peer: Address,
  ) {}
}
*/

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
          log.info(`${feedId} invoked blobs.get with ${args}`);
          yield new Uint8Array(0);
        },
        createWants(
          args: Record<string, string>[],
        ): AsyncIterable<Record<string, unknown>> {
          log.info(`${feedId} invoked blobs.createWants with  ${args}`);
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  return new Promise((resolve) => {
                    /*resolve({
                      value: new BlobWant(new BlobId(new Uint8Array())),
                    });*/
                    const wanter = ((want: BlobWant) => {
                      wantFeeds.delete(wanter);
                      resolve({ value: want });
                    });
                    wantFeeds.add(wanter);
                  });
                },
              };
            },
          };
        },
      },
    };
    return rpcMethods;
  }
  incomingConnection(_rpcConnection: RpcConnection): Promise<void> {
    log.error("Method not implemented.");
    return Promise.resolve();
  }
  outgoingConnection = this.incomingConnection;

  run(_connector: {
    connect(address: Address): Promise<RpcConnection>;
  }): Promise<void> {
    log.error("Method not implemented.");
    return Promise.resolve();
  }
}
