import ScuttlebuttHost, { Config as ParentConfig } from "./ScuttlebuttHost.ts";
import FeedsStorage from "./storage/FeedsStorage.ts";
import { parseKeyPair, serializeKeyPair, sodium } from "./util.ts";
import WsTransportClient from "./comm/transport/ws/WsTransportClient.ts";
import { LocalStorageFeedsStorage } from "./storage/local-storage/LocalStorageFeedsStorage.ts";
import { LocalStorageBlobsStorage } from "./storage/local-storage/LocalStorageBlobsStorage.ts";
import RankingTableStorage from "./storage/RankingTableStorage.ts";

export {
  FeedId,
  parseAddress,
  parseFeedId,
  parseKeyPair,
  serializeKeyPair,
  toBase64,
} from "./util.ts";

export default class BrowserScuttlebuttHost extends ScuttlebuttHost {
  constructor(config: ParentConfig) {
    super(config);
    this.transportClients.add(new WsTransportClient());
  }
  protected createFeedsStorage(): FeedsStorage {
    return new LocalStorageFeedsStorage();
  }

  protected createRankingTableStorage(): RankingTableStorage {
    return new LocalStorageFeedsStorage();
  }

  protected createBlobsStorage() {
    return new LocalStorageBlobsStorage();
  }

  protected getClientKeyPair() {
    const secret = localStorage.getItem("ssb-identity");
    if (secret) {
      return parseKeyPair(secret);
    } else {
      const newKey = sodium.crypto_sign_keypair("uint8array");
      localStorage.setItem("ssb-identity", serializeKeyPair(newKey));
      return newKey;
    }
  }
}
