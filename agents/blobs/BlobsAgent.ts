import RpcConnection from "../../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../../comm/rpc/types.ts";
import {
  Address,
  BlobId,
  concat,
  FeedId,
  log,
  parseBlobId,
} from "../../util.ts";
import Agent from "../Agent.ts";
import * as FsStorage from "../../fsStorage.ts";

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
    this.pendingWants.set(want.blobId.base64Key, new PendingWant(want));
  }

  private wantFeeds = new Set<(_: BlobWant) => void>();

  /** key is base64 of BlobId */
  private pendingWants = new Map<string, PendingWant>();

  /** key is base64 of FeedId */
  private connections = new Map<string, WeakRef<RpcConnection>>();

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
          const blobId = parseBlobId(Object.keys(args[0])[0]);
          yield await FsStorage.getBlob(blobId);
        },
        async *createWants(
          args: Record<string, string>[],
        ): AsyncIterable<Record<string, unknown>> {
          log.info(`${feedId} invoked blobs.createWants with  ${args}`);
          for (const p of pendingWants.values()) {
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
  async handleConnection(rpcConnection: RpcConnection): Promise<void> {
    this.connections.set(
      rpcConnection.boxConnection.peer.base64Key,
      new WeakRef(rpcConnection),
    );
    const wantsReader = await rpcConnection.sendSourceRequest({
      name: ["blobs", "createWants"],
      args: {},
    });
    while (true) {
      const hasOrWantMessage = await wantsReader.read();
      for (const entry of Object.entries(hasOrWantMessage)) {
        const hasOrWant = new BlobWant(
          parseBlobId(entry[0]),
          parseInt(entry[1] as string),
        );
        log.debug(
          `Got has/want from ${rpcConnection.boxConnection.peer}: ${
            JSON.stringify(hasOrWant)
          }`,
        );
        if (hasOrWant.level > 0) {
          //a has
          if (this.pendingWants.has(hasOrWant.blobId.base64Key)) {
            const pendingWant = this.pendingWants.get(
              hasOrWant.blobId.base64Key,
            );
            await this.retrieveBlobFromPeer(
              pendingWant!.want.blobId,
              rpcConnection.boxConnection.peer,
            );
          }
        }
      }
    }
  }
  incomingConnection = this.handleConnection;
  outgoingConnection = this.handleConnection;

  run(_connector: {
    connect(address: Address): Promise<RpcConnection>;
  }): Promise<void> {
    log.info(
      "BlobsAgent only acts on connections established by other agents and incoming connections.",
    );
    return Promise.resolve();
  }

  async retrieveBlobFromPeer(blobId: BlobId, peer: FeedId) {
    const rpcConnection = this.connections.get(peer.base64Key)?.deref();
    if (!rpcConnection) {
      throw new Error("No open connection to peer available.");
    }
    const reader = await rpcConnection.sendSourceRequest({
      name: ["blobs", "get"],
      args: [blobId],
    });
    const chunks: Array<Uint8Array> = [];
    try {
      while (true) {
        const chunk = await reader.read() as Uint8Array;
        chunks.push(chunk);
      }
    } catch (error) {
      //that's why we should get back an async iterable
      log.debug(error);
    }
    const content = concat(...chunks);
    const storedBlobId = await FsStorage.storeBlob(content);
    if (storedBlobId.base64Key !== blobId.base64Key) {
      throw new Error(`Got ${storedBlobId} but expected ${blobId}`);
    }
  }
}
