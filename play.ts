import SsbHost, { BoxConnection } from "./SsbHost.ts";
import { parseAddress } from "./util.ts";
import { delay } from "https://deno.land/std@0.100.0/async/mod.ts";
import RPCConnection, { EndOfStream } from "./RPCConnection.ts";

const decoder = new TextDecoder();
const host = new SsbHost();

if (Deno.args.length !== 1) {
  throw new Error("expecting exactly one argument");
}

const addressString = Deno.args[0]; // "net:172.17.0.2:8008~shs:bEhA+VRRIf8mTO474KlSuYTObJACRYZqkwxCl4Id4fk="
const address = parseAddress(
  addressString,
);

const boxConnection: BoxConnection = await host.connect(
  address,
);

const rpcConnection = new RPCConnection(boxConnection);
let lastActivity = Date.now();
/*async function monitorConnection() {
  let i = 0;
  try {
    for await (const message of boxConnection) {
      lastActivity = Date.now();
      console.log(i++, message);
      console.log("as text", decoder.decode(message));
    }
  } catch (e) {
    if (e.name === "Interrupted") {
      // ignore
    } else {
      throw e;
    }
  }
}

monitorConnection();*/

console.log("sending a message...");

const historyStream = await rpcConnection.sendSourceRequest({
  "name": ["createHistoryStream"],
  "args": [{ "id": `@${address.key}.ed25519` }],
});
(async () => {
  while (true) {
    try {
      const msg = await historyStream.read();
      lastActivity = Date.now();
      console.log(
        JSON.stringify(JSON.parse(decoder.decode(msg)), undefined, 2),
      );
    } catch (err) {
      if (err instanceof EndOfStream) {
        console.error("Stream ended");
      } else {
        console.error(err);
      }
    }
  }
})();

const blobId = "&cnuH8kTYmu2O685OruWm8TVNR7tKfItKCP+L+pDE8xs=.sha256";

const hasBlob = await rpcConnection.sendAsyncRequest({
  "name": ["blobs", "has"],
  "args": [blobId],
});

console.log(hasBlob);

if (hasBlob) {
  await Deno.mkdir("data/blobs", { recursive: true });
  const blobFile = await Deno.create(
    "data/blobs/" + blobId.replaceAll("/", "_").replaceAll("+", "-"),
  ); //RFC3548 filename safe alphabet
  const blobStream = await rpcConnection.sendSourceRequest({
    "name": ["blobs", "get"],
    "args": [blobId],
  });
  (async () => {
    while (true) {
      try {
        const msg = await blobStream.read();
        let written = 0;
        while (written < msg.length) {
          written += await blobFile.write(msg.subarray(written));
        }
        console.log(`wrote ${written} bytes to file`);
        lastActivity = Date.now();
        //console.log("blob data", msg);
      } catch (err) {
        if (err instanceof EndOfStream) {
          console.error("Stream ended");
        } else {
          console.error(err);
        }
        break;
      }
    }
    blobFile.close();
  })();
}

const waitForInactivity = async () => {
  if (Date.now() - lastActivity > 5000) {
    return;
  } else {
    await delay(5000);
    await waitForInactivity();
  }
};

await waitForInactivity();
boxConnection.close();
