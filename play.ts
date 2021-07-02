import SsbHost, { RpcBodyType } from "./SsbHost.ts";
import { parseAddress } from "./util.ts";
import { delay } from "https://deno.land/std@0.100.0/async/mod.ts";

const decoder = new TextDecoder();
const host = new SsbHost();

if (Deno.args.length !== 1) {
  throw new Error("expecting exactly one argument");
}

const addressString = Deno.args[0]; // "net:172.17.0.2:8008~shs:bEhA+VRRIf8mTO474KlSuYTObJACRYZqkwxCl4Id4fk="
const address = parseAddress(
  addressString,
);

const boxConnection = await host.connect(
  address,
);
let lastActivity = Date.now();
async function monitorConnection() {
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

monitorConnection();

console.log("sending a message...");
/*boxConnection.sendRpcMessage({
  "name": ["blobs", "createWants"],
  "args": [],
  "type": "source",
}, {
  bodyType: RpcBodyType.json,
});*/

boxConnection.sendRpcMessage({
  "name": ["createHistoryStream"],
  "type": "source",
  "args": [{ "id": `@${address.key}.ed25519` }],
}, {
  bodyType: RpcBodyType.json,
  isStream: true,
});

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
