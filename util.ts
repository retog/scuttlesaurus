import sodium, {
  base64_variants as base64Variants,
} from "https://deno.land/x/sodium@0.2.0/sumo.ts";

import iconv from "https://dev.jspm.io/iconv-lite";

const textEncoder = new TextEncoder();

export function parseAddress(addr: string) {
  const sections = addr.split(":");
  const [protocol, host, portshs, key] = sections;
  const port = parseInt(portshs.split("~")[0]);
  return { protocol, host, port, key };
}

export function bytes2NumberUnsigned(bytes: Uint8Array): number {
  return bytes.length === 0 ? 0 : bytes[0] * Math.pow(0x100, bytes.length - 1) +
    bytes2NumberUnsigned(bytes.subarray(1));
}

export function bytes2NumberSigned(bytes: Uint8Array): number {
  return bytes[0] & 0b10000000
    ? -Math.pow(2, 7 + (bytes.length - 1) * 8) + (0b01111111 &
          bytes[0]) * Math.pow(0x100, bytes.length - 1) +
      bytes2NumberUnsigned(bytes.subarray(1))
    : bytes2NumberUnsigned(bytes);
}

export function concat(...elems: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    elems.reduce((sum, elem) => sum + (elem.length), 0),
  );
  let pos = 0;
  for (const elem of elems) {
    result.set(elem, pos);
    pos += elem.length;
  }
  return result;
}

export async function readBytes(reader: Deno.Reader, length: number) {
  const result = new Uint8Array(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const remainder = result.subarray(bytesRead);
    try {
      const bytesReadNow = await reader.read(remainder);
      if (bytesReadNow === null) {
        throw new Error(
          `End of reader, expecting ${remainder.length} more bytes`,
        );
      }
      bytesRead += bytesReadNow;
    } catch (e) {
      //console.error(`At ${bytesRead}/${length}`,e);
      throw e;
    }
  }
  return result;
}
/** convert base64 from standard to filename-safe alphabet */
export const filenameSafeAlphabetRFC3548 = (orig: string) =>
  orig.replaceAll("/", "_").replaceAll("+", "-");

export function toBase64(data: Uint8Array) {
  return sodium.to_base64(
    data,
    base64Variants.ORIGINAL_NO_PADDING,
  );
}

export function fromBase64(text: string) {
  return sodium.from_base64(
    text,
    base64Variants.ORIGINAL_NO_PADDING,
  );
}

function nodeBinaryEncode(s: string): Uint8Array {
  return (iconv as {encode: (s: string, e: string) => Uint8Array}).encode(s, "binary")
}

export function computeMsgHash(msg: unknown) {
  return sodium.crypto_hash_sha256(
    nodeBinaryEncode(JSON.stringify(msg, undefined, 2)),
  );
}

/*export function signMessage(msg: unknown): Record<string, unknown> {
  return sodium.crypto_hash_sha256(textEncoder.encode(JSON.stringify(msg, undefined, 2)))
}*/

export function verifySignature(msg: { author: string; signature?: string }) {
  if (!msg.signature) {
    throw Error("no signature in messages");
  }
  const signatureString = msg.signature;
  const signature = fromBase64(
    signatureString.substring(
      0,
      signatureString.length - ".sig.ed25519".length,
    ),
  );
  const authorsPubkicKey = fromBase64(
    msg.author.substring(1, msg.author.length - ".ed25519".length),
  );
  delete msg.signature;
  const verifyResult = sodium.crypto_sign_verify_detached(
    signature,
    textEncoder.encode(JSON.stringify(msg, undefined, 2)),
    authorsPubkicKey,
  );
  msg.signature = signatureString;
  return verifyResult;
}
