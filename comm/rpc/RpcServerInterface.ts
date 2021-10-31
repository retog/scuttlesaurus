import BoxServerInterface from "../box/BoxServerInterface.ts";
import RpcConnection from "./RpcConnection.ts";
import { RequestHandler } from "./types.ts";
import { FeedId } from "../../util.ts";
import CommServerInterface from "../CommServerInterface.ts";

export default class RpcSeverInterface
  implements CommServerInterface<RpcConnection> {
  constructor(
    public requestHandlerBuilder: (_: FeedId) => RequestHandler,
    public boxServerInterface: BoxServerInterface,
  ) {}

  async *listen() {
    for await (const boxConnection of this.boxServerInterface.listen()) {
      yield new RpcConnection(
        boxConnection,
        this.requestHandlerBuilder(boxConnection.peer),
      );
    }
  }
}
