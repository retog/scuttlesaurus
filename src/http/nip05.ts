/**
 * NIP-05 identity for the owner, served at `/.well-known/nostr.json`. Names
 * the owner as `_` and lists the node's relay for the owner. Contract:
 * `docs/ARCHITECTURE.md`, "HTTP surface".
 * @module
 */
import type { Config } from "../types.ts";
import { externalBase, relayUrlOf } from "../base_url.ts";
import { jsonResponse } from "./respond.ts";

/**
 * The NIP-05 document: `{ names: { _: owner }, relays: { owner: [relayUrl] } }`
 * once there is an owner, and `{ names: {} }` before first-run setup.
 */
export function nip05Response(config: Config, request: Request): Response {
  if (config.owner === undefined) return jsonResponse({ names: {} });
  const relay = relayUrlOf(externalBase(request, config));
  return jsonResponse({
    names: { _: config.owner },
    relays: { [config.owner]: [relay] },
  });
}
