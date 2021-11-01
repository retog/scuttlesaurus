import ScuttlebuttHost from "./ScuttlebuttHost.ts";
import FeedsStorage from "./storage/FeedsStorage.ts";
import { sodium } from "./util.ts";
import WsTransportClient from "./comm/transport/ws/WsTransportClient.ts";
import { LocalStorageFeedsStorage } from "./storage/local-storage/LocalStorageFeedsStorage.ts";
import { LocalStorageBlobsStorage } from "./storage/local-storage/LocalStorageBlobsStorage.ts";

export default class BrowserScuttlebuttHost extends ScuttlebuttHost {
  constructor() {
    super({
      follow: ["@luoZnBKHXeJl4kB39uIkZnQD4L0zl6Vd+Pe75gKS4fo=.ed25519"],
      peers: [
        "wss://scuttleboot.app~shs:luoZnBKHXeJl4kB39uIkZnQD4L0zl6Vd+Pe75gKS4fo=",
      ],
    });
    this.transportClients.add(new WsTransportClient());
  }
  protected createFeedsStorage(): FeedsStorage {
    return new LocalStorageFeedsStorage();
  }

  protected createBlobsStorage() {
    return new LocalStorageBlobsStorage();
  }

  protected getClientKeyPair() {
    //TODO store
    const newKey = sodium.crypto_sign_keypair("uint8array");
    return newKey;
  }
}
