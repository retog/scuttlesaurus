import Transport from "./Transport.ts";
import { Address, concat, flatten, log } from "../../util.ts";

function makeConnectionLike(socket: WebSocket) {
  log.debug(`making connection like`);
  const open = new Promise((resolve, _reject) => {
    socket.onopen = () => {
      log.debug("Connection opened");
      resolve(true);
    };
  });
  let buffer = new Uint8Array(0);
  const openDataPromises: Promise<ArrayBuffer>[] = [];
  socket.onmessage = (m: MessageEvent) => {
    if (m.data.arrayBuffer) {
      openDataPromises.push(m.data.arrayBuffer());
    } else {
      openDataPromises.push(m.data);
    }
    /*log.info(`Received ${new Uint8Array(data).length}:
              ${new Uint8Array(data)}`);*/
  };
  const result: Deno.Reader & Deno.Writer & Deno.Closer = {
    read: (p: Uint8Array) =>
      open.then(() =>
        new Promise((resolve, _reject) => {
          const resolveFromBuffer = () => {
            if (p.length >= buffer.length) {
              p.set(buffer, 0);
              resolve(buffer.length);
              buffer = new Uint8Array(0);
            } else {
              p.set(buffer.subarray(0, p.length), 0);
              buffer = buffer.slice(p.length);
              resolve(p.length);
            }
          };
          const resolveFromDataPromises = async () => {
            const oldestPromise = openDataPromises.shift();
            const data = await oldestPromise;
            buffer = concat(buffer, new Uint8Array(data!));
            resolveFromBuffer();
          };
          if (buffer.length === 0) {
            if (openDataPromises.length === 0) {
              const origOnmessage = socket.onmessage!;
              socket.onmessage = (m: MessageEvent) => {
                origOnmessage.apply(socket, [m]);
                socket.onmessage = origOnmessage;
                resolveFromDataPromises();
              };
            } else {
              resolveFromDataPromises();
            }
          } else {
            resolveFromBuffer();
          }
        })
      ),
    write: (p: Uint8Array) =>
      open.then(() =>
        new Promise((resolve, _reject) => {
          socket.send(p);
          resolve(p.length);
        })
      ),
    close: () => {
      socket.close();
    },
  };
  return result;
}

export default class WsTransport implements Transport {
  constructor(public options: { port: number } = { port: 8989 }) {}
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
