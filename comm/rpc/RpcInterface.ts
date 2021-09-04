import BoxInterface from "../box/BoxInterface.ts";
import RpcConnection from "./RpcConnection.ts";
import { RequestHandler } from "./types.ts";
import { Address, FeedId } from "../../util.ts";
import CommInterface from "../CommInterface.ts";

export default class RPCInterface implements CommInterface<RpcConnection> {
  constructor(
    public requestHandlerBuilder: (_: FeedId) => RequestHandler,
    public boxPeer: BoxInterface,
  ) {}

  async connect(
    address: Address,
  ) {
    const boxConnection = await this.boxPeer.connect(address);
    return new RpcConnection(
      boxConnection,
      this.requestHandlerBuilder(boxConnection.peer),
    );
  }

  async *listen() {
    for await (const boxConnection of this.boxPeer.listen()) {
      yield new RpcConnection(
        boxConnection,
        this.requestHandlerBuilder(boxConnection.peer),
      );
    }
  }
}
