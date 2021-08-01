import ScuttlebuttPeer from "./ScuttlebuttPeer.ts";
import BoxConnection from "./BoxConnection.ts";
import Procedures from "./Procedures.ts";
import { updateFeeds } from "./feedSubscriptions.ts";
import { log, parseAddress, path } from "./util.ts";
import RPCConnection from "./RPCConnection.ts";
import config from "./config.ts";
import { delay } from "https://deno.land/std@0.103.0/async/mod.ts";

const peersFile = path.join(config.baseDir, "peers.json");

function getPeers() {
  try {
    return JSON.parse(Deno.readTextFileSync(peersFile));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }
}
const peers: string[] = getPeers();

const host = new ScuttlebuttPeer();

host.listen();

if (Deno.args.length !== 1) {
  log.error("expecting one argument");
  Deno.exit(1);
}

host.addEventListener("connected", async (options) => {
  log.debug("new connection");
  const boxConnection: BoxConnection = (options as CustomEvent).detail;
  const rpcConnection = new RPCConnection(boxConnection, new Procedures());
  await updateFeeds(rpcConnection);
});
let initialDelaySec = 0;
await Promise.all(peers.map((address) =>
  (async () => {
    await delay(initialDelaySec * 1000);
    initialDelaySec += 10;
    let minutesDelay = 1;
    while (true) {
      try {
        if (host.connections.length > 20) {
          log.info("More than 20 connections open, standing by.")
        } else {
          log.info(`${host.connections.length} connections open, connecting to ${address}`)
          await host.connect(parseAddress(address));
        }
      } catch (error) {
        log.error(`In connection with ${address}: ${error}`);
        minutesDelay++;
      }
      await delay(minutesDelay * 60 * 1000);
    }
  })()
));
