/**
 * NIP-98 HTTP authorization for the owner's endpoints. The owner's client signs
 * a kind 27235 event per request that names the request's absolute URL and
 * method and, for a body, its SHA-256. Contract: `docs/ARCHITECTURE.md`,
 * "Node API" and "SPARQL endpoint".
 *
 * The URL check is done here rather than with the library helper: the URL the
 * client signed may be the one the server sees or the one rebuilt on the
 * external base URL behind a reverse proxy.
 * @module
 */
import { encodeHex } from "@std/encoding/hex";
import type { Config, NostrEvent } from "../types.ts";
import { externalBase } from "../base_url.ts";
import {
  NostrAuthorizationError,
  parseNostrAuthorization,
} from "../nostr_auth.ts";
import { errorResponse, HttpError } from "./respond.ts";

/** The kind of HTTP authorization events (NIP-98). */
export const HTTP_AUTH_KIND = 27235;

/** Largest difference between `created_at` and the server clock, in seconds. */
const MAX_AGE_SECONDS = 60;

/**
 * Authorize a request as the node's owner (NIP-98).
 *
 * The body is passed in, already read, because a request body can be read
 * only once. Pass an empty array for requests without one.
 *
 * @param body The request body; its SHA-256 must match a `payload` tag when
 *   the body is not empty.
 * @returns The owner's hex public key when the request is authorized, else the
 *   error response: 401 for a missing, malformed, stale or mismatched
 *   authorization, 403 when the signer is not the owner.
 */
export async function authorizeOwner(
  request: Request,
  config: Config,
  body: Uint8Array,
): Promise<string | Response> {
  try {
    const event = parseAuthorization(request.headers.get("authorization"));
    await checkRequest(event, request, config, body);
    if (config.owner === undefined || event.pubkey !== config.owner) {
      throw new HttpError(403, "only the owner of this node may do that");
    }
    return event.pubkey;
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse(
        error.status,
        error.message,
        error.status === 401 ? { "WWW-Authenticate": "Nostr" } : {},
      );
    }
    throw error;
  }
}

/**
 * The verified event of the `Authorization` header.
 *
 * @throws {HttpError} 401 when the header is missing, malformed or unsigned.
 */
function parseAuthorization(header: string | null): NostrEvent {
  try {
    return parseNostrAuthorization(header);
  } catch (error) {
    if (error instanceof NostrAuthorizationError) {
      throw new HttpError(401, error.message);
    }
    throw error;
  }
}

/**
 * The checks that bind the event to this request: kind, age, URL, method and
 * payload.
 *
 * @throws {HttpError} 401 when one of them does not hold.
 */
async function checkRequest(
  event: NostrEvent,
  request: Request,
  config: Config,
  body: Uint8Array,
): Promise<void> {
  if (event.kind !== HTTP_AUTH_KIND) {
    throw new HttpError(401, "authorization is not kind 27235");
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > MAX_AGE_SECONDS) {
    throw new HttpError(401, "authorization is stale");
  }

  const url = tagValue(event, "u");
  if (url === undefined || !urlMatches(url, request, config)) {
    throw new HttpError(401, "authorization is for another URL");
  }

  const method = tagValue(event, "method");
  if (method === undefined || method !== request.method) {
    throw new HttpError(401, "authorization is for another method");
  }

  // A request with a body must be signed together with it; otherwise a token
  // seen in transit could be replayed with different content.
  if (body.byteLength > 0) {
    const payload = tagValue(event, "payload");
    if (payload === undefined) {
      throw new HttpError(401, "authorization does not cover the body");
    }
    if (payload.toLowerCase() !== await sha256Hex(body)) {
      throw new HttpError(401, "authorization does not match the body");
    }
  }
}

/**
 * Whether the URL in the event is the URL of the request, either as the
 * server sees it or as it is rebuilt on the external base URL. Fragments are
 * ignored; everything else must match exactly after URL normalization.
 */
function urlMatches(
  claimed: string,
  request: Request,
  config: Config,
): boolean {
  const expected = normalizeUrl(claimed);
  if (expected === undefined) return false;
  const url = new URL(request.url);
  const candidates = [
    normalizeUrl(url.href),
    normalizeUrl(externalBase(request, config) + url.pathname + url.search),
  ];
  return candidates.includes(expected);
}

/** An absolute URL without its fragment, normalized by the URL parser. */
function normalizeUrl(text: string): string | undefined {
  try {
    const url = new URL(text);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** The value of the first tag with the given name, if it has one. */
function tagValue(event: NostrEvent, name: string): string | undefined {
  const tag = event.tags.find((candidate) => candidate[0] === name);
  return tag?.[1];
}

/** The lower-case hex SHA-256 of some bytes. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return encodeHex(new Uint8Array(digest));
}
