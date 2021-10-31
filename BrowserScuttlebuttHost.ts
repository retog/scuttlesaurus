import ScuttlebuttHost from "./ScuttlebuttHost.ts";
import FeedsStorage from "./storage/FeedsStorage.ts";
import BlobsStorage from "./storage/BlobsStorage.ts";
import FeedsAgent from "./agents/feeds/FeedsAgent.ts";
import BlobsAgent from "./agents/blobs/BlobsAgent.ts";
import {
  BlobId,
  FeedId,
  fromBase64,
  JSONValue,
  parseAddress,
  parseFeedId,
  sha256Hash,
  sodium,
  toBase64,
} from "./util.ts";
import WsTransportClient from "./comm/transport/ws/WsTransportClient.ts";

class LocalStoreFeedsStorage implements FeedsStorage {
  private storageKey(feedKey: FeedId, position: number) {
    return feedKey.base64Key + "@" + position;
  }

  storeMessage(
    feedKey: FeedId,
    position: number,
    msg: JSONValue,
  ): Promise<void> {
    window.localStorage.setItem(
      this.storageKey(feedKey, position),
      JSON.stringify(msg),
    );
    if (position > this.lastMessageSync(feedKey)) {
      window.localStorage.setItem(
        feedKey.base64Key,
        position.toString(),
      );
    }
    return Promise.resolve();
  }
  getMessage(
    feedKey: FeedId,
    position: number,
  ): Promise<{ key: string; value: JSONValue; timestamp: number }> {
    const jsonMsg = window.localStorage.getItem(
      this.storageKey(feedKey, position),
    );
    if (!jsonMsg) {
      throw new Deno.errors.NotFound();
    }
    return Promise.resolve(JSON.parse(jsonMsg));
  }
  lastMessage(feedKey: FeedId): Promise<number> {
    return Promise.resolve(this.lastMessageSync(feedKey));
  }
  private lastMessageSync(feedKey: FeedId): number {
    const positionStr = window.localStorage.getItem(
      feedKey.base64Key,
    );
    if (positionStr) {
      return parseInt(positionStr);
    } else {
      return 0;
    }
  }
}

class LocalStoreBlobsStorage implements BlobsStorage {
  async hasBlob(blobId: BlobId): Promise<boolean> {
    return (await localStorage.getItem(blobId.toString())) !== null;
  }
  async storeBlob(data: Uint8Array): Promise<BlobId> {
    const blobId = new BlobId(sha256Hash(data));
    await localStorage.setItem(blobId.toString(), toBase64(data));
    return blobId;
  }
  async getBlob(blobId: BlobId): Promise<Uint8Array> {
    const encodedData = localStorage.getItem(blobId.toString());
    if (encodedData === null) {
      throw new Error(`No such blob stored: ${blobId}`);
    }
    return await fromBase64(encodedData);
  }
}

export default class BrowserScuttlebuttHost extends ScuttlebuttHost {
  constructor() {
    super({});
    this.transportClients.add(new WsTransportClient());
  }
  protected createFeedsAgent() {
    const storage = new LocalStoreFeedsStorage();
    return new FeedsAgent(storage, [
      parseFeedId("@luoZnBKHXeJl4kB39uIkZnQD4L0zl6Vd+Pe75gKS4fo=.ed25519"),
    ], [
      parseAddress(
        "wss://scuttleboot.app~shs:luoZnBKHXeJl4kB39uIkZnQD4L0zl6Vd+Pe75gKS4fo=",
      ),
    ]);
  }

  protected createBlobsAgent() {
    const storage = new LocalStoreBlobsStorage();
    return new BlobsAgent(storage);
  }

  protected getClientKeyPair() {
    //TODO store
    const newKey = sodium.crypto_sign_keypair("uint8array");
    return newKey;
  }
}
