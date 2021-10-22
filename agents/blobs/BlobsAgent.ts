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
import FsStorage from "../../storage/FsStorage.ts";

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
  readonly interestedPeers: Set<string> = new Set<string>();

  constructor(
    public want: BlobWant,
    onBehalfOf?: FeedId,
    public alreadyAsked: Set<string> = new Set<string>(), //using base 64 strings as mutable Uint8Aray can't be compared
  ) {
    this.created = Date.now();
    if (onBehalfOf) {
      this.interestedPeers.add(onBehalfOf.base64Key);
    }
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

  constructor(public fsStorage: FsStorage) {
    super();
  }
  want(blobId: BlobId) {
    this.processWant(new BlobWant(blobId));
  }

  private processWant(want: BlobWant, onBehalfOf?: FeedId) {
    const alreadyPendingWant = this.pendingWants.get(
      want.blobId.base64FilenameSafe,
    );
    if (alreadyPendingWant) {
      if (onBehalfOf) {
        alreadyPendingWant.interestedPeers.add(onBehalfOf.base64Key);
      }
    } else {
      //write to feeds
      for (const f of this.wantFeeds.entries()) {
        if (f[0] !== onBehalfOf?.base64Key) {
          f[1](want);
        }
      }
      //and store to ask on new conections
      this.pendingWants.set(
        want.blobId.base64Key,
        new PendingWant(want, onBehalfOf),
      );
    }
  }

  //maps a FeedKey to the feed on which to sent wants/has
  private wantFeeds = new Map<string, (_: BlobWant) => void>();

  /** key is base64 of BlobId */
  private pendingWants = new Map<string, PendingWant>();

  /** key is base64 of FeedId */
  private connections = new Map<string, WeakRef<RpcConnection>>();

  createRpcContext(feedId: FeedId): RpcContext {
    const wantFeeds = this.wantFeeds;
    const pendingWants = this.pendingWants;
    const fsStorage = this.fsStorage;
    const rpcMethods = {
      blobs: {
        /*has(args: Record<string, string>[]): Promise<boolean> {
          log.info(`${feedId} asked about ${args}`);
          return Promise.resolve(false);
        },*/
        async *get(args: (Record<string, string> | string)[]) {
          log.debug(
            `${feedId} invoked blobs.get with args: ${JSON.stringify(args)}.`,
          );
          let blobIdString: string;
          if (typeof args[0] === "string") {
            blobIdString = args[0];
          } else {
            blobIdString = args[0].key;
            //TODO consider max and size
          }
          const blobId = parseBlobId(blobIdString);
          yield await fsStorage.getBlob(blobId);
        },
        async *createWants(
          args: Record<string, string>[],
        ): AsyncIterable<Record<string, unknown>> {
          log.info(
            `${feedId} invoked blobs.createWants with  ${JSON.stringify(args)}`,
          );
          for (const p of pendingWants.values()) {
            if (
              !p.alreadyAsked.has(feedId.base64Key) &&
              !p.interestedPeers.has(feedId.base64Key)
            ) {
              yield p.want.shortWant;
              p.alreadyAsked.add(feedId.base64Key);
            }
          }
          while (true) {
            yield await new Promise((resolve) => {
              /*resolve({
                      value: new BlobWant(new BlobId(new Uint8Array())),
                    });*/
              const wanter = ((want: BlobWant) => {
                wantFeeds.delete(feedId.base64Key);
                resolve(want.shortWant);
              });
              wantFeeds.set(feedId.base64Key, wanter);
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
    for await (const hasOrWantMessage of wantsReader) {
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
        if (hasOrWant.level >= 0) {
          //a has
          if (this.pendingWants.has(hasOrWant.blobId.base64Key)) {
            const pendingWant = this.pendingWants.get(
              hasOrWant.blobId.base64Key,
            )!;
            await this.retrieveBlobFromPeer(
              pendingWant.want.blobId,
              rpcConnection.boxConnection.peer,
            );
            //tell interested peers that we have it
            await Promise.all(
              [...pendingWant.interestedPeers].map(async (feedKey) => {
                const wantFeed = this.wantFeeds.get(feedKey);
                if (wantFeed) {
                  wantFeed(
                    new BlobWant(
                      hasOrWant.blobId,
                      (await this.fsStorage.getBlob(hasOrWant.blobId)).length,
                    ),
                  );
                }
              }),
            );
          }
        } else {
          //a want
          if (await this.fsStorage.hasBlob(hasOrWant.blobId)) {
            const wantFeed = this.wantFeeds.get(
              rpcConnection.boxConnection.peer.base64Key,
            );
            if (wantFeed) {
              const blob = await this.fsStorage.getBlob(hasOrWant.blobId);
              wantFeed(new BlobWant(hasOrWant.blobId, blob.length));
            } else {
              //TODO tell them if and when they invoke createWants, add to a broadened pendingWants set
              log.warning(
                `${rpcConnection.boxConnection.peer} asked for a blob we have, but we can't tell them`,
              );
            }
          } else {
            this.processWant(
              new BlobWant(hasOrWant.blobId, hasOrWant.level - 1),
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
    for await (const chunk of reader) {
      chunks.push(chunk as Uint8Array);
    }
    const content = concat(...chunks);
    const storedBlobId = await this.fsStorage.storeBlob(content);
    if (storedBlobId.base64Key !== blobId.base64Key) {
      throw new Error(`Got ${storedBlobId} but expected ${blobId}`);
    }
  }
}
