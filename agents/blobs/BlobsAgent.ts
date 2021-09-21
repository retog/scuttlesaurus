import RpcConnection from "../../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../../comm/rpc/types.ts";
import { Address, BlobId, FeedId, log } from "../../util.ts";
import Agent from "../Agent.ts";

class BlobWant implements Record<string, unknown> {
  constructor(public blobId: BlobId, public level = -1) {}

  /*toJSON() {
    const shortWant = {}as Record<string, number>;
    shortWant[this.blobId.toString()]= this.level;
    return JSON.stringify(shortWant);
  }*/

  get shortWant() {
    const shortWant = {} as Record<string, number>;
    shortWant[this.blobId.toString()] = this.level;
    return shortWant;
  }

  [x: string]: unknown
}

class PendingWant {
  readonly created: number;

  constructor(
    public want: BlobWant,
    public alreadyAsked: Set<FeedId> = new Set<FeedId>(),
  ) {
    this.created = Date.now();
  }

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
  want(blobId: BlobId) {
    this.processWant(new BlobWant(blobId));
  }

  private processWant(want: BlobWant) {
    //write to feeds
    this.wantFeeds.forEach((f) => f(want));
    //and store to ask on new conections
    this.pendingWants.push(new PendingWant(want));
  }

  private wantFeeds = new Set<(_: BlobWant) => void>();

  private pendingWants: PendingWant[] = [];

  createRpcContext(feedId: FeedId): RpcContext {
    const wantFeeds = this.wantFeeds;
    const pendingWants = this.pendingWants;
    const rpcMethods = {
      blobs: {
        /*has(args: Record<string, string>[]): Promise<boolean> {
          log.info(`${feedId} asked about ${args}`);
          return Promise.resolve(false);
        },*/
        async *get(args: Record<string, string>[]) {
          log.debug(`${feedId} invoked blobs.get with args: ${args}.`);
          yield new Uint8Array(0);
        },
        async *createWants(
          args: Record<string, string>[],
        ): AsyncIterable<Record<string, unknown>> {
          log.info(`${feedId} invoked blobs.createWants with  ${args}`);
          for (const p of pendingWants) {
            if (!p.alreadyAsked.has(feedId)) {
              yield p.want.shortWant;
              p.alreadyAsked.add(feedId);
            }
          }
          while (true) {
            yield await new Promise((resolve) => {
              /*resolve({
                      value: new BlobWant(new BlobId(new Uint8Array())),
                    });*/
              const wanter = ((want: BlobWant) => {
                wantFeeds.delete(wanter);
                resolve({ value: want.shortWant });
              });
              wantFeeds.add(wanter);
            });
          }
        },
      },
    };
    return rpcMethods;
  }
  async incomingConnection(rpcConnection: RpcConnection): Promise<void> {
    const wantsReader = await rpcConnection.sendSourceRequest({
      name: ["blobs", "createWants"],
      args: {},
    });
    while (true) {
      const hasOrWant = await wantsReader.read();
      log.info(
        `Got has/want from ${rpcConnection.boxConnection.peer}: ${
          JSON.stringify(hasOrWant)
        }`,
      );
    }
  }
  outgoingConnection = this.incomingConnection;

  run(_connector: {
    connect(address: Address): Promise<RpcConnection>;
  }): Promise<void> {
    log.error("Method not implemented.");
    return Promise.resolve();
  }
}
