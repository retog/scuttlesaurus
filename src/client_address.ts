/**
 * Who a request comes from, for per-client limits (the SPARQL time budget,
 * the relay's connection and Nostr Connect limits).
 *
 * The client is the TCP peer, unless the peer is a reverse proxy the node
 * trusts. Which proxies are trusted is the `trustedProxies` setting
 * (`TRUSTED_PROXIES`):
 *
 * - `0`: never; the TCP peer is the client. For a node without a proxy.
 * - `n` (1 to 5): the node sits behind a chain of `n` proxies, each of which
 *   appends the address it saw to `X-Forwarded-For`. When the peer is on this
 *   machine or a private network, the client is the `n`-th entry from the
 *   right. With fewer entries the leftmost is taken.
 * - `auto` (default): like `1`.
 *
 * A public peer is never trusted, so a client that reaches the node directly
 * cannot choose its identity with the header.
 *
 * IPv4 clients are keyed by their address. IPv6 clients are keyed by their
 * /64 network (`2001:db8:1:2::/64`), since an ordinary host has a whole /64 to
 * pick source addresses from.
 *
 * @module
 */

/** The address used when the peer is not known (tests calling the handler). */
export const UNKNOWN_CLIENT = "unknown";

/** The `trustedProxies` setting: `"auto"` or a number of proxy hops (0 to 5). */
export type TrustedProxies = "auto" | number;

/** Most proxy hops that can be configured. */
export const MAX_TRUSTED_PROXIES = 5;

interface Recorded {
  /** The key the limits use. */
  key: string;
  /**
   * The peer was a local address that should have been a proxy but sent no
   * `X-Forwarded-For`, so every client behind it shares this key.
   */
  unforwarded: boolean;
}

const recorded = new WeakMap<Request, Recorded>();

/** Record the peer of a request; called once by the HTTP handler. */
export function rememberClient(
  request: Request,
  peer: Deno.Addr | undefined,
  trusted: TrustedProxies = "auto",
): void {
  if (!peer || !("hostname" in peer)) return;
  const hops = trusted === "auto" ? 1 : trusted;
  const peerAddress = normalize(peer.hostname);
  let address = peerAddress;
  let unforwarded = false;
  if (hops > 0 && isLocalAddress(peerAddress)) {
    const chain = (request.headers.get("x-forwarded-for") ?? "")
      .split(",").map((item) => normalize(item)).filter((item) =>
        isIpAddress(item)
      );
    if (chain.length > 0) {
      address = chain[Math.max(0, chain.length - hops)];
    } else unforwarded = true;
  }
  recorded.set(request, { key: clientKey(address), unforwarded });
}

/** The client key recorded for a request, or {@link UNKNOWN_CLIENT}. */
export function clientAddress(request: Request): string {
  return recorded.get(request)?.key ?? UNKNOWN_CLIENT;
}

const warned = new Set<string>();

/**
 * Say once per key, when a limit refuses a client whose key is a local
 * address that came without `X-Forwarded-For`, that a reverse proxy in front
 * of the node may be sending none, so that all its clients share one
 * allowance.
 */
export function noteLimitReached(request: Request): void {
  const entry = recorded.get(request);
  if (!entry?.unforwarded || warned.has(entry.key) || warned.size > 100) {
    return;
  }
  warned.add(entry.key);
  console.warn(
    `limits: requests from ${entry.key} reached a per-client limit. If a ` +
      "reverse proxy runs in front of the node, it must send " +
      "X-Forwarded-For, or all its clients share one allowance; without a " +
      "proxy, set TRUSTED_PROXIES=0. See docs/INSTALL.md.",
  );
}

/**
 * The key the limits use for an address: IPv4 as it is, IPv6 by its /64
 * network.
 */
export function clientKey(address: string): string {
  const groups = ipv6Groups(address);
  if (!groups) return address;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** Lower case, without brackets, port, zone or the IPv4-mapped prefix. */
function normalize(address: string): string {
  let host = address.trim().toLowerCase();
  // `[2001:db8::1]:443` and `198.51.100.1:443`, as some proxies write them.
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(host);
  if (bracketed) host = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(host)) host = host.split(":")[0];
  return host.replace(/%.*$/, "")
    .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "").slice(0, 64);
}

function isIpv4(host: string): boolean {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return parts !== null && parts.slice(1).every((p) => Number(p) <= 255);
}

function isIpAddress(host: string): boolean {
  return isIpv4(host) || ipv6Groups(host) !== undefined;
}

/** The eight 16-bit groups of an IPv6 address, or undefined if it is none. */
function ipv6Groups(host: string): number[] | undefined {
  if (!host.includes(":")) return undefined;
  let text = host;
  // A trailing IPv4 part (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    if (!isIpv4(v4[1])) return undefined;
    const [a, b, c, d] = v4[1].split(".").map(Number);
    text = text.slice(0, -v4[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => part === "" ? [] : part.split(":");
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...Array(missing).fill("0"), ...tail];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.map((g) => parseInt(g, 16));
}

/** Loopback, private (RFC 1918), link-local, CGNAT or unique-local addresses. */
export function isLocalAddress(address: string): boolean {
  const host = normalize(address);
  if (isIpv4(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  const groups = ipv6Groups(host);
  if (!groups) return false;
  const loopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  return loopback || (groups[0] & 0xfe00) === 0xfc00 ||
    (groups[0] & 0xffc0) === 0xfe80;
}
