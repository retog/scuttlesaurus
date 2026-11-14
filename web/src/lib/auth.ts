/**
 * NIP-98 HTTP authorization for the node's owner-only endpoints.
 *
 * The token names the absolute URL (`u`) and the method, and for a request
 * with a body a `payload` tag holding the hex SHA-256 of the exact bytes sent.
 * The library's own payload hashing covers the JSON of a value, not the body
 * bytes, so the tag is added here.
 *
 * @module
 */
import * as nip98 from "@nostr/tools/nip98";
import type { EventTemplate } from "@nostr/tools/core";
import { sha256Hex } from "./hash.ts";
import { canSign, signEvent } from "./session.ts";

/**
 * An `Authorization` header value (`Nostr <base64>`) for `method` on `path`,
 * or `undefined` when the session cannot sign.
 *
 * @param body The exact request body text that will be sent, if any. Its hash
 *   goes into the `payload` tag; omit it for requests without a body.
 */
export async function getAuthorization(
  path: string,
  method: string,
  body?: string,
): Promise<string | undefined> {
  if (!canSign.value) return undefined;
  const url = new URL(path, globalThis.location.origin).href;
  const payload = body ? sha256Hex(body) : undefined;
  const sign = (template: EventTemplate) =>
    signEvent(
      payload
        ? { ...template, tags: [...template.tags, ["payload", payload]] }
        : template,
    );
  return await nip98.getToken(url, method, sign, true);
}
