import SsbHost from "./SsbHost.ts";
import BoxConnection from "./BoxConnection.ts";
import * as FSStorage from "./fsStorage.ts";
import Procedures from "./Procedures.ts";
import {
  computeMsgHash,
  filenameSafeAlphabetRFC3548,
  parseAddress,
  toBase64,
  verifySignature,
} from "./util.ts";
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
      const msg = await historyStream.read() as {
        value: Record<string, string>;
        key: string;
      };
      const hash = computeMsgHash(msg.value);
      const key = `%${toBase64(hash)}.sha256`;
      if (key !== msg.key) {
        throw new Error(
          "Computed hash doesn't match key " +
            JSON.stringify(msg, undefined, 2),
        );
      }
      if (
        !verifySignature(msg.value as { author: string; signature: string })
      ) {
        throw Error(
          `failed to veriy signature of the message: ${
            JSON.stringify(msg.value, undefined, 2)
          }`,
        );
      }
      const msgFile = await Deno.create(
        feedDir + "/" +
          (msg as { value: Record<string, string> }).value!.sequence! + ".json",
      );
      await msgFile.write(
        textEncoder.encode(JSON.stringify(msg, undefined, 2)),
      );
      msgFile.close();
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
