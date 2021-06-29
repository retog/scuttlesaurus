import SsbHost from "./SsbHost.ts";
import { parseAddress } from "./util.ts";
//import udpPeerDiscoverer from "./udpPeerDiscoverer.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const host = new SsbHost();

const boxConnection = await host.connect(
  parseAddress(
    "net:172.17.0.2:8008~shs:bEhA+VRRIf8mTO474KlSuYTObJACRYZqkwxCl4Id4fk=",
  ),
);
async function monitorConnection() {
  let i = 0;
  for await (const message of boxConnection) {
    console.log(i++, message);
    console.log("as text", decoder.decode(message));
  }
}

monitorConnection();

console.log("sending a message...");

boxConnection.write(
  encoder.encode('{"name":["blobs","createWants"],"args":[],"type":"source"}'),
);
