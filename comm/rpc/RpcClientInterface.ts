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
    public config: {
      answerTimeout?: number;
      activityTimeout?: number;
    } = {
      answerTimeout: 30000,
      activityTimeout: 6000,
    },
  ) {
    config.answerTimeout ??= 30000;
    config.activityTimeout ??= 6000;
  }

  async connect(
    address: Address,
  ) {
    const boxConnection = await this.boxClientInterface.connect(address);
    return new RpcConnection(
      boxConnection,
      this.requestHandlerBuilder(boxConnection.peer),
      this.config,
    );
  }
}
