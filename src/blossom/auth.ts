/**
 * Authorization events of BUD-01 and BUD-02: kind 24242 events in the
 * `Authorization: Nostr <base64>` header.
 * @module
 */
import {
  NostrAuthorizationError,
  parseNostrAuthorization,
} from "../nostr_auth.ts";
import type { NostrEvent } from "../types.ts";
import { BlossomError } from "./errors.ts";

/** The actions an authorization event can name in its `t` tag. */
export type Action = "upload" | "delete" | "list" | "get";

/** The kind of Blossom authorization events. */
export const AUTH_KIND = 24242;

/** Clock skew tolerated for `created_at`, in seconds. */
const SKEW_SECONDS = 60;

/** A verified authorization event. */
export interface Authorization {
  /** Hex public key of the signer. */
  pubkey: string;
  event: NostrEvent;
}

/**
 * Validate the authorization of a request for an action (BUD-01, BUD-02).
 * The event must be a correctly signed kind 24242 event, name the action in
 * a `t` tag, not be expired and not be created in the future.
 *
 * @param now Current unix time in seconds.
 * @throws {BlossomError} 401 when the authorization is missing or invalid.
 */
export function authorize(
  headers: Headers,
  action: Action,
  now: number,
): Authorization {
  let event: NostrEvent;
  try {
    event = parseNostrAuthorization(headers.get("authorization"));
  } catch (error) {
    if (error instanceof NostrAuthorizationError) {
      throw new BlossomError(401, error.message);
    }
    throw error;
  }
  if (event.kind !== AUTH_KIND) {
    throw new BlossomError(401, "authorization is not kind 24242");
  }
  if (!tagValues(event, "t").includes(action)) {
    throw new BlossomError(401, `authorization is not for ${action}`);
  }
  const expiration = Number(tagValues(event, "expiration")[0]);
  if (!Number.isFinite(expiration) || expiration <= now) {
    throw new BlossomError(401, "authorization has expired");
  }
  if (event.created_at > now + SKEW_SECONDS) {
    throw new BlossomError(401, "authorization is created in the future");
  }
  return { pubkey: event.pubkey, event };
}

/** Whether the authorization names the blob in an `x` tag. */
export function covers(auth: Authorization, sha256: string): boolean {
  return tagValues(auth.event, "x").includes(sha256);
}

/** The values of all tags with the given name. */
export function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}
