import BoxClientInterface from "../box/BoxClientInterface.ts";
import RpcConnection from "./RpcConnection.ts";
import { RequestHandler } from "./types.ts";
import { Address, FeedId } from "../../util.ts";
import CommClientInterface from "../CommClientInterface.ts";

export default class RpcClientInterface
  implements CommClientInterface<RpcConnection> {
  constructor(
    public requestHandlerBuilder: (_: FeedId) => RequestHandler,
    public boxClientInterface: BoxClientInterface,
  ) {}

  async connect(
    address: Address,
  ) {
    const boxConnection = await this.boxClientInterface.connect(address);
    return new RpcConnection(
      boxConnection,
      this.requestHandlerBuilder(boxConnection.peer),
    );
  }
}
