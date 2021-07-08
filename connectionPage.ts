import type { Response } from "https://deno.land/x/oak@v7.5.0/mod.ts";
import sodium, {
  base64_variants as base64Variants,
} from "https://deno.land/x/sodium@0.2.0/sumo.ts";
import { parseAddress } from "./util.ts";
import type SsbHost from "./SsbHost.ts";

export default async function (
  addressString: string,
  host: SsbHost,
  response: Response,
) {
  const address = parseAddress(addressString);
  const connection = await host.connect(address);
  const firstData = await connection.read();
  const secondData = await connection.read();
  const thirdData = await connection.read();
  response.body = `
    Client id: @${
    sodium.to_base64(
      host.clientLongtermKeyPair.publicKey,
      base64Variants.ORIGINAL_NO_PADDING,
    )
  }.ed25519<p>
    ${JSON.stringify(address)} shaking ${addressString}<p> 
    Sent: ${connection.hello}<p>
    Got: ${connection.serverResponse}<p>
    Then got: ${connection.serverResponse2}<p>
    detached_signature_B: ${connection.detached_signature_B}<br/>
    firstData = ${firstData} as string ${
    new TextDecoder().decode(firstData)
  }<br/>
    secondData = ${secondData} as string ${
    new TextDecoder().decode(secondData)
  }<br/>
    thirdData = ${thirdData} as string ${
    new TextDecoder().decode(thirdData)
  }<br/>
    `;
  connection.close();
}
