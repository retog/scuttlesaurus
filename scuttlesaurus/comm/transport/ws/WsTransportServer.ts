import TransportServer from "../TransportServer.ts";
import { flatten, log } from "../../../util.ts";
import makeConnectionLike from "./makeConnectionLike.ts";

export default class WsTransportServer implements TransportServer {
  constructor(public options: { port: number } = { port: 8989 }) {}
  protocols = ["ws", "wss"];

  async *listen() {
    const options = this.options;
    const getHttpConnections = async function* () {
      const server = Deno.listen(options);
      for await (const conn of server) {
        yield Deno.serveHttp(conn)[Symbol.asyncIterator]();
      }
    };
    const httpRequests = flatten(getHttpConnections()[Symbol.asyncIterator]());

    for await (
      const requestEvent of { [Symbol.asyncIterator]: () => httpRequests }
    ) {
      if (requestEvent.request.headers.get("upgrade") != "websocket") {
        //request isn't trying to upgrade to websocket
        requestEvent.respondWith(
          new Response("This endpoint currently only supports websocket.", {
            status: 200,
          }),
        );
        continue;
      }
      const { socket, response } = Deno.upgradeWebSocket(requestEvent.request);
      requestEvent.respondWith(response);
      yield makeConnectionLike(socket);
      log.debug("ws response sent");
    }
  }
}
