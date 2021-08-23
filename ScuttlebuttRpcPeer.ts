import ScuttlebuttBoxPeer from "./ScuttlebuttBoxPeer.ts";
import RPCConnection, { EndOfStream, RequestHandler } from "./RPCConnection.ts";
import {
  Address,
  concat,
  FeedId,
  fromBase64,
  log,
  path,
  readBytes,
  toBase64,
} from "./util.ts";
import BoxConnection from "./BoxConnection.ts";

export default class ScuttlebuttRpcPeer extends EventTarget {
  constructor(
    public requestHandler: RequestHandler,
    public boxPeer: ScuttlebuttBoxPeer = new ScuttlebuttBoxPeer(),
  ) {
    super();
    boxPeer.addEventListener("connected", (options) => {
      const boxConnection: BoxConnection = (options as CustomEvent).detail;
      const rpcConnection = new RPCConnection(
        boxConnection,
        this.requestHandler,
      );
      this.dispatchEvent(
        new CustomEvent("connected", { "detail": rpcConnection }),
      );
    });
  }

  async connect(
    address: Address,
  ) {
    const boxConnection = await this.boxPeer.connect(address);
    return new RPCConnection(boxConnection, this.requestHandler);
  }

  listen() {
    return this.boxPeer.listen();
  }
}
