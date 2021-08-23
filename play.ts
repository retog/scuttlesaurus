import ScuttlebuttRpcPeer from "./ScuttlebuttRpcPeer.ts";
import Procedures from "./Procedures.ts";
import { updateFeedFrom } from "./feedSubscriptions.ts";
import { log, parseAddress, parseBlobId, parseFeedId, path } from "./util.ts";
import RPCConnection, { EndOfStream } from "./RPCConnection.ts";
import config from "./config.ts";
import { getBlobFile } from "./fsStorage.ts";

const host = new ScuttlebuttRpcPeer(new Procedures());

if (Deno.args.length < 1) {
  throw new Error("expecting at least one argument");
}

const addressString = Deno.args[0]; // "net:172.17.0.2:8008~shs:bEhA+VRRIf8mTO474KlSuYTObJACRYZqkwxCl4Id4fk="
const address = parseAddress(
  addressString,
);

const feedKey = Deno.args.length > 1 ? parseFeedId(Deno.args[1]) : address.key;

const rpcConnection: RPCConnection = await host.connect(address);

log.info("sending a message...");

updateFeedFrom(rpcConnection, feedKey, 1);

const blobId = "&cnuH8kTYmu2O685OruWm8TVNR7tKfItKCP+L+pDE8xs=.sha256";
const hasBlobP =  rpcConnection.sendAsyncRequest({
  "name": ["blobs", "has"],
  "args": [blobId],
});

//hasBlobP.then(log.info, log.error)

const hasBlob = await hasBlobP;

if (hasBlob) {
  const blobFile = await getBlobFile(parseBlobId(blobId));
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

const wantsStream = await rpcConnection.sendSourceRequest({
  "name": ["blobs", "createWants"],
  "args": [],
});
//(async () => {
  while (true) {
    log.info(`They want ${JSON.stringify(await wantsStream.read())}`);
  }
//})();
