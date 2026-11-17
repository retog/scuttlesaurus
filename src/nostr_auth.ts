/**
 * The `Authorization: Nostr <base64>` header shared by NIP-98 (owner
 * endpoints) and Blossom (BUD-01): decoding it into a signed event. What the
 * event must say (kind, URL, action, age) is each caller's business.
 *
 * @module
 */
import { decodeBase64 } from "@std/encoding/base64";
import { validateEvent, verifyEvent } from "@nostr/tools/pure";
import type { NostrEvent } from "./types.ts";

/** Largest accepted header value in characters; a real one is about 1 KiB. */
export const MAX_AUTHORIZATION_LENGTH = 64 * 1024;

/** Why an `Authorization` header was not accepted; the message is for the client. */
export class NostrAuthorizationError extends Error {}

/**
 * The event in an `Authorization: Nostr <base64>` header, with its structure,
 * id and signature verified.
 *
 * @throws {NostrAuthorizationError} when the header is missing, too large,
 *   malformed or not correctly signed.
 */
export function parseNostrAuthorization(header: string | null): NostrEvent {
  if (header === null) {
    throw new NostrAuthorizationError("missing authorization");
  }
  if (header.length > MAX_AUTHORIZATION_LENGTH) {
    throw new NostrAuthorizationError("authorization is too large");
  }
  const match = /^Nostr\s+(\S+)$/i.exec(header);
  if (match === null) {
    throw new NostrAuthorizationError("authorization is not a Nostr event");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(decodeBase64(match[1])));
  } catch {
    throw new NostrAuthorizationError(
      "authorization is not base64-encoded JSON",
    );
  }
  // validateEvent checks the unsigned structure only, so id and sig are
  // checked here; verifyEvent may throw on a malformed key or signature.
  let signed = false;
  try {
    signed = typeof value === "object" && value !== null &&
      validateEvent(value) &&
      "id" in value && typeof value.id === "string" &&
      "sig" in value && typeof value.sig === "string" &&
      verifyEvent(value as NostrEvent);
  } catch {
    signed = false;
  }
  if (!signed) {
    throw new NostrAuthorizationError("invalid authorization signature");
  }
  return value as NostrEvent;
}
