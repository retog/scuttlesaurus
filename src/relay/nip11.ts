/**
 * The NIP-11 relay information document, served as `application/nostr+json`.
 * @module
 */
import denoJson from "../../deno.json" with { type: "json" };
import type { Config } from "../types.ts";
import {
  MAX_FILTERS,
  MAX_MESSAGE_BYTES,
  MAX_SUBID_LENGTH,
  MAX_SUBSCRIPTIONS,
} from "./protocol.ts";

/**
 * The NIP-11 information response for the relay. Config fields are read at
 * the time of the call, because the configuration changes at runtime.
 */
export function relayInformation(config: Config): Response {
  const document = {
    name: config.name,
    description: config.description,
    pubkey: config.owner,
    software: "https://github.com/retog/scuttlesaurus",
    version: denoJson.version,
    supported_nips: [1, 2, 9, 10, 11, 18, 22, 23, 25, 45, 50, 65],
    limitation: {
      max_subscriptions: MAX_SUBSCRIPTIONS,
      max_filters: MAX_FILTERS,
      max_limit: config.maxLimit,
      max_subid_length: MAX_SUBID_LENGTH,
      max_message_length: MAX_MESSAGE_BYTES,
      auth_required: false,
      payment_required: false,
      restricted_writes: true,
    },
  };
  return new Response(JSON.stringify(document), {
    headers: {
      "Content-Type": "application/nostr+json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
