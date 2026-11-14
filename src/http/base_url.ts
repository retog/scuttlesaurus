/**
 * The base URL under which the node is seen from outside, and the relay URL
 * derived from it. Used by the API, NIP-05 and NIP-98 URL checks.
 * @module
 */
import type { Config } from "../types.ts";

/**
 * The external base URL without a trailing slash: the configured public URL
 * if there is one, else the origin the reverse proxy reported in
 * `X-Forwarded-Proto` and `X-Forwarded-Host`, else the origin of the request.
 */
export function externalBase(request: Request, config: Config): string {
  if (config.publicUrl !== undefined && config.publicUrl !== "") {
    return config.publicUrl.replace(/\/+$/, "");
  }
  return forwardedOrigin(request.headers) ?? new URL(request.url).origin;
}

/** The WebSocket relay URL for an external base URL, with a trailing slash. */
export function relayUrlOf(base: string): string {
  return base.replace(/^http/, "ws") + "/";
}

/** The origin named by the forwarding headers, if both are present and valid. */
function forwardedOrigin(headers: Headers): string | undefined {
  const scheme = firstItem(headers.get("x-forwarded-proto"))?.toLowerCase();
  const host = firstItem(headers.get("x-forwarded-host"));
  if (scheme === undefined || host === undefined) return undefined;
  if (scheme !== "http" && scheme !== "https") return undefined;
  // A host with a path, query, credentials or whitespace is not an origin.
  if (/[/?#@\s\\]/.test(host)) return undefined;
  try {
    const url = new URL(`${scheme}://${host}`);
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/** The first comma-separated item of a header value, trimmed. */
function firstItem(value: string | null): string | undefined {
  const item = value?.split(",")[0].trim();
  return item === undefined || item === "" ? undefined : item;
}
