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
import { canSign, signEvent } from "./session.ts";

/** Lower-case hex SHA-256 of a string's UTF-8 bytes. */
async function sha256Hex(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "This page needs a secure connection (https or localhost) to sign requests",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

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
  const payload = body ? await sha256Hex(body) : undefined;
  const sign = (template: EventTemplate) =>
    signEvent(
      payload
        ? { ...template, tags: [...template.tags, ["payload", payload]] }
        : template,
    );
  return await nip98.getToken(url, method, sign, true);
}
