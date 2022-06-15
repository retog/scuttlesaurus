import { concat } from "../../../util.ts";

export default function makeConnectionLike(
  socket: WebSocket,
): Deno.Reader & Deno.Writer & Deno.Closer {
  console.debug(`making connection like`);
  const open = new Promise((resolve, _reject) => {
    socket.onopen = () => {
      console.debug("Connection opened");
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
    /*console.info(`Received ${new Uint8Array(data).length}:
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
