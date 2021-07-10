import SsbHost, { BoxConnection } from "./SsbHost.ts";
import * as FSStorage from "./fsStorage.ts";
import Procedures from "./Procedures.ts";
import {
  computeMsgHash,
  filenameSafeAlphabetRFC3548,
  parseAddress,
  toBase64,
  verifySignature,
} from "./util.ts";
import { delay } from "https://deno.land/std@0.100.0/async/mod.ts";
import RPCConnection, { EndOfStream } from "./RPCConnection.ts";

const host = new SsbHost();
const textEncoder = new TextEncoder();

if (Deno.args.length < 1) {
  throw new Error("expecting at least one argument");
}

const addressString = Deno.args[0]; // "net:172.17.0.2:8008~shs:bEhA+VRRIf8mTO474KlSuYTObJACRYZqkwxCl4Id4fk="
const address = parseAddress(
  addressString,
);

function strip(feedId: string) {
  if (feedId.startsWith("@") && feedId.endsWith(".ed25519")) {
    return feedId.substring(1, feedId.length - 8);
  } else {
    console.log(feedId + " doesn't seems to be dressed");
    return feedId;
  }
}

const feedKey = Deno.args.length > 1 ? strip(Deno.args[1]) : address.key;

const boxConnection: BoxConnection = await host.connect(
  address,
);

const rpcConnection = new RPCConnection(boxConnection, new Procedures());
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
  "args": [{ "id": `@${feedKey}.ed25519`, "seq": 1 }],
});
(async () => {
  const feedDir = FSStorage.getFeedDir(feedKey);
  await Deno.mkdir(feedDir, { recursive: true });
  while (true) {
    try {
      const msg = await historyStream.read() as Record<string, unknown>;
      const hash = computeMsgHash(msg.value!);
      console.log("hash", toBase64(hash));
      //TODO verify message sinature
      console.log(
        "ver: ",
        verifySignature(msg.value as { author: string; signature: string }),
      );
      const msgFile = await Deno.create(
        feedDir + "/" +
          (msg as { value: Record<string, string> }).value!.sequence! + ".json",
      );
      await msgFile.write(
        textEncoder.encode(JSON.stringify(msg, undefined, 2)),
      );
      msgFile.close();
      lastActivity = Date.now();
      /*console.log(
        JSON.stringify(msg, undefined, 2),
      );*/
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
    "data/blobs/" + filenameSafeAlphabetRFC3548(blobId),
  );
  const blobStream = await rpcConnection.sendSourceRequest({
    "name": ["blobs", "get"],
    "args": [blobId],
  });
  (async () => {
    while (true) {
      try {
        const msg = await blobStream.read() as Uint8Array;
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
