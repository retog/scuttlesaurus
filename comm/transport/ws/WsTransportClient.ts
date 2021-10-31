import TransportClient from "../TransportClient.ts";
import { Address } from "../../../util.ts";
import makeConnectionLike from "./makeConnectionLike.ts";

export default class WsTransportClient implements TransportClient {
  constructor() {}
  protocols = ["ws", "wss"];
  //seemingly pointless aync ensures exceptions result in rejected promise
  async connect(
    addr: Address,
  ): Promise<Deno.Reader & Deno.Writer & Deno.Closer> {
    const socket = new WebSocket(
      `${addr.protocol}:${addr.host}${addr.port ? `:${addr.port}` : ""}`,
    );
    return await Promise.resolve(makeConnectionLike(socket));
  }
}
