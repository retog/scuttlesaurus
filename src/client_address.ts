/**
 * Who a request comes from, for per-client limits (the SPARQL time budget,
 * the relay's Nostr Connect limits).
 *
 * The address is that of the TCP peer. When the peer is on this machine or a
 * private network, it is taken to be the reverse proxy in front of the node,
 * and the last entry of `X-Forwarded-For` (the one that proxy added) is used
 * instead. A public peer cannot change its identity by sending the header.
 *
 * @module
 */

/** The address used when the peer is not known (tests calling the handler). */
export const UNKNOWN_CLIENT = "unknown";

const addresses = new WeakMap<Request, string>();

/** Record the peer of a request; called once by the HTTP handler. */
export function rememberClient(
  request: Request,
  peer: Deno.Addr | undefined,
): void {
  if (!peer || !("hostname" in peer)) return;
  const forwarded = request.headers.get("x-forwarded-for")
    ?.split(",").at(-1)?.trim();
  addresses.set(
    request,
    forwarded && isLocalAddress(peer.hostname)
      ? normalize(forwarded)
      : normalize(peer.hostname),
  );
}

/** The client address recorded for a request, or {@link UNKNOWN_CLIENT}. */
export function clientAddress(request: Request): string {
  return addresses.get(request) ?? UNKNOWN_CLIENT;
}

/** Lower case, without brackets, zone or the IPv4-mapped prefix. */
function normalize(address: string): string {
  return address.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "")
    .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "").slice(0, 64);
}

/** Loopback, private (RFC 1918), link-local, CGNAT or unique-local addresses. */
export function isLocalAddress(address: string): boolean {
  const host = normalize(address);
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe[89ab][0-9a-f]:/.test(host);
}
