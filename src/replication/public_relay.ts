/**
 * Guard against server-side request forgery through relay lists. A NIP-65
 * relay list (kind 10002) is written by somebody else, so the URLs in it must
 * not be able to make this server open connections into its own network.
 *
 * Only the spelling of the URL is judged: DNS names that resolve to private
 * addresses (including rebinding tricks) are out of scope and need a network
 * level control such as an egress firewall.
 * @module
 */

const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
];

/** Whether `ip` (four octets) is outside the public internet. */
function isPrivateIPv4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

function parseIPv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : undefined;
}

/** Eight 16-bit groups of an IPv6 literal (without brackets). */
function parseIPv6(host: string): number[] | undefined {
  let text = host;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (!v4) return undefined;
    const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
    text = `${text.slice(0, -tail[1].length)}${hex(v4[0], v4[1])}:${
      hex(v4[2], v4[3])
    }`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string) => part === "" ? [] : part.split(":");
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [
    ...head,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...rest,
  ];
  const numbers = all.map((
    g,
  ) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return numbers.length === 8 && numbers.every((n) => !Number.isNaN(n))
    ? numbers
    : undefined;
}

function isPrivateIPv6(g: number[]): boolean {
  const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(7) && g[7] <= 1) return true; // unspecified and loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (zeros(5) && g[5] === 0xffff) return isPrivateIPv4(embedded); // mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateIPv4(embedded); // NAT64
  }
  return false;
}

/**
 * Whether a relay URL may be taken from somebody else's relay list: it must be
 * `wss://` and its host must not be a name or address of a local, private,
 * link-local or otherwise non-public network. Unparseable URLs are not public.
 */
export function isPublicRelayUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "wss:") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    const groups = parseIPv6(host.slice(1, -1));
    return groups !== undefined && !isPrivateIPv6(groups);
  }
  const v4 = parseIPv4(host);
  if (v4) return !isPrivateIPv4(v4);
  if (!host.includes(".") || host === "localhost") return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
