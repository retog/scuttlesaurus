import ScuttlebuttHost, { Config as ParentConfig } from "./ScuttlebuttHost.ts";
import FeedsStorage from "./storage/FeedsStorage.ts";
import { log, parseKeyPair, serializeKeyPair, sodium } from "./util.ts";
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
    configureLogging();
    this.transportClients.add(new WsTransportClient());
  }
  protected createFeedsStorage(): FeedsStorage & RankingTableStorage {
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

async function configureLogging() {
  const params = new URLSearchParams(window.location.search);
  const logLevel = params.has("log") ? params.get("log") as string : "INFO";
  await log.setup({
    handlers: {
      console: new log.handlers.ConsoleHandler(logLevel as LogLevel),
    },
    loggers: {
      default: {
        level: logLevel as LogLevel,
        handlers: ["console"],
      },
    },
  });
  log.info(`Log level of set to ${logLevel}`);
}
type LogLevel = (
  | "INFO"
  | "NOTSET"
  | "DEBUG"
  | "WARNING"
  | "ERROR"
  | "CRITICAL"
);
