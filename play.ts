import SsbHost from "./SsbHost.ts";
import BoxConnection from "./BoxConnection.ts";
import Procedures from "./Procedures.ts";
import { updateFeed } from "./feedSubscriptions.ts";
import {
  filenameSafeAlphabetRFC3548,
  log,
  parseAddress,
  path,
} from "./util.ts";
import RPCConnection, { EndOfStream } from "./RPCConnection.ts";
import config from "./config.ts";

const host = new SsbHost();

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
    log.info(feedId + " doesn't seems to be dressed");
    return feedId;
  }
}

const feedKey = Deno.args.length > 1 ? strip(Deno.args[1]) : address.key;

const boxConnection: BoxConnection = await host.connect(
  address,
);

const rpcConnection = new RPCConnection(boxConnection, new Procedures());

log.info("sending a message...");

updateFeed(rpcConnection, feedKey);

const blobId = "&cnuH8kTYmu2O685OruWm8TVNR7tKfItKCP+L+pDE8xs=.sha256";

const hasBlob = await rpcConnection.sendAsyncRequest({
  "name": ["blobs", "has"],
  "args": [blobId],
});

if (hasBlob) {
  await Deno.mkdir(path.join(config.dataDir, "blobs"), { recursive: true });
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
        log.info(`wrote ${written} bytes to file`);
        //log.info("blob data", msg);
      } catch (err) {
        if (err instanceof EndOfStream) {
          log.error("Stream ended");
        } else {
          log.error(err);
        }
        break;
      }
    }
    blobFile.close();
  })();
}
