import ScuttlebuttPeer from "./ScuttlebuttPeer.ts";
import BoxConnection from "./BoxConnection.ts";
import Procedures from "./Procedures.ts";
import { updateFeeds } from "./feedSubscriptions.ts";
import { log, parseAddress } from "./util.ts";
import RPCConnection from "./RPCConnection.ts";

const host = new ScuttlebuttPeer();

host.listen();

if (Deno.args.length !== 1) {
  log.error("expecting one argument");
  Deno.exit(1);
}

const addressString = Deno.args[0]; // "net:172.17.0.2:8008~shs:bEhA+VRRIf8mTO474KlSuYTObJACRYZqkwxCl4Id4fk="
const address = parseAddress(
  addressString,
);

host.addEventListener("connected", async (options) => {
  log.debug("new connection");
  const boxConnection: BoxConnection = (options as CustomEvent).detail;
  const rpcConnection = new RPCConnection(boxConnection, new Procedures());
  await updateFeeds(rpcConnection);
});

await host.connect(
  address,
);
