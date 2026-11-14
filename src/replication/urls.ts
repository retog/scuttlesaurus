/**
 * Relay URL hygiene. Every relay URL the replicator touches goes through
 * {@link relayUrl}, so the same relay is never known under two spellings.
 * @module
 */
import { normalizeURL } from "@nostr/tools/utils";

/**
 * The normalized form of a relay URL (lower-case host, a path, `ws`/`wss`
 * scheme), or undefined when it is not a usable WebSocket URL.
 */
export function relayUrl(url: string): string | undefined {
  try {
    const normalized = normalizeURL(url);
    const { protocol } = new URL(normalized);
    return protocol === "ws:" || protocol === "wss:" ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** Normalize a list of relay URLs, dropping unusable ones and duplicates. */
export function relayUrls(urls: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const url of urls) {
    const normalized = relayUrl(url);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}
