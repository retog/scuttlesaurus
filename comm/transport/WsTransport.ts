import Transport from "./Transport.ts";
import { Address, concat, log } from "../../util.ts";
//import * as ws from "https://deno.land/std@0.109.0/ws/mod.ts";
import { serve } from "https://deno.land/std@0.109.0/http/mod.ts";
import { listenAndServe } from "https://deno.land/std@0.109.0/http/server.ts";

async function makeConnectionLike(socket: WebSocket) {
  await new Promise((resolve, _reject) => {
    socket.onopen = resolve;
  });
  let buffer = new Uint8Array(0);
  const openDataPromises: Promise<ArrayBuffer>[] = [];
  socket.onmessage = (m: MessageEvent) => {
    openDataPromises.push(m.data.arrayBuffer());
    /*log.info(`Received ${new Uint8Array(data).length}:
              ${new Uint8Array(data)}`);*/
  };
  const result: Deno.Reader & Deno.Writer & Deno.Closer = {
    read: (p: Uint8Array) =>
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
      }),
    write: (p: Uint8Array) =>
      new Promise((resolve, _reject) => {
        socket.send(p);
        resolve(p.length);
      }),
    close: () => socket.close(),
  };
  return result;
}

export default class WsTransport implements Transport {
  constructor() {}
  protocols = ["ws", "wss"];
  connect(
    addr: Address,
  ): Promise<Deno.Reader & Deno.Writer & Deno.Closer> {
    const socket = new WebSocket(
      `${addr.protocol}:${addr.host}${addr.port ? `:${addr.port}` : ""}`,
    );
    return makeConnectionLike(socket);
  }
  async *listen() {
    const handleReq = (req: Request): Response => {
      if (req.headers.get("upgrade") != "websocket") {
        return new Response("request isn't trying to upgrade to websocket.");
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      //yield await makeConnectionLike(socket); //welll this never returns before we return....
      socket.onopen = () => console.log("socket opened");
      socket.onmessage = (e) => {
        console.log("socket message:", e.data);
        socket.send(new Date().toString());
      };
      socket.onerror = (e) => console.log("socket errored:", e);
      socket.onclose = () => console.log("socket closed");
      return response;
    };
    const server = Deno.listen({ port: 5000 });
    for await (const conn of server) {
      (async () => {
        const httpConn = Deno.serveHttp(conn);
        for await (const requestEvent of httpConn) {
          await requestEvent.respondWith(handleReq(requestEvent.request));
        }
      })();
    }
    let a = 1;
    if (a === 2) {
      yield undefined as unknown as Deno.Reader & Deno.Writer & Deno.Closer; //FIXME
    }
  }
}
