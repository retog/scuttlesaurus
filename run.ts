import SsbHost from "./SsbHost.ts";
import BoxConnection from "./BoxConnection.ts";
import Procedures from "./Procedures.ts";
import { updateFeeds } from "./feedSubscriptions.ts";
import { parseAddress } from "./util.ts";
import RPCConnection, { EndOfStream } from "./RPCConnection.ts";

const host = new SsbHost();

if (Deno.args.length !== 1) {
  throw new Error("expecting one argument");
}

const addressString = Deno.args[0]; // "net:172.17.0.2:8008~shs:bEhA+VRRIf8mTO474KlSuYTObJACRYZqkwxCl4Id4fk="
const address = parseAddress(
  addressString,
);

const boxConnection: BoxConnection = await host.connect(
  address,
);

const rpcConnection = new RPCConnection(boxConnection, new Procedures());

updateFeeds(rpcConnection);
