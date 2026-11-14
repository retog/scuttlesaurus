/**
 * NIP-98 HTTP authorization for the node's owner-only endpoints.
 *
 * @module
 */
import * as nip98 from "@nostr/tools/nip98";
import { canSign, signEvent } from "./session.ts";

/**
 * An `Authorization` header value (`Nostr <base64>`) for `method` on
 * `path`, or `undefined` when the session cannot sign.
 */
export async function getAuthorization(
  path: string,
  method: string,
): Promise<string | undefined> {
  if (!canSign.value) return undefined;
  const url = new URL(path, globalThis.location.origin).href;
  return await nip98.getToken(url, method, signEvent, true);
}
