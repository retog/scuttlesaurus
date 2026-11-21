import { assertEquals } from "@std/assert";
import {
  clientAddress,
  clientKey,
  isLocalAddress,
  noteLimitReached,
  rememberClient,
  type TrustedProxies,
  UNKNOWN_CLIENT,
} from "./client_address.ts";

const peer = (hostname: string): Deno.Addr => ({
  transport: "tcp",
  hostname,
  port: 1234,
});

const request = (forwardedFor?: string) =>
  new Request("http://node.test/", {
    headers: forwardedFor ? { "X-Forwarded-For": forwardedFor } : {},
  });

/** The client key of a request from `from` with the given header. */
function client(
  from: string,
  forwardedFor?: string,
  trusted: TrustedProxies = "auto",
): string {
  const r = request(forwardedFor);
  rememberClient(r, peer(from), trusted);
  return clientAddress(r);
}

Deno.test("the peer address is the client, and a public peer cannot forge another", () => {
  assertEquals(client("203.0.113.7"), "203.0.113.7");
  assertEquals(client("203.0.113.7", "198.51.100.1"), "203.0.113.7");
  assertEquals(client("203.0.113.7", "198.51.100.1", 2), "203.0.113.7");
  assertEquals(clientAddress(request()), UNKNOWN_CLIENT);
});

Deno.test("behind one local proxy the last forwarded address is the client", () => {
  for (const proxy of ["127.0.0.1", "::1", "172.18.0.3", "::ffff:10.0.0.2"]) {
    assertEquals(
      client(proxy, "198.51.100.1, 203.0.113.9"),
      "203.0.113.9",
      proxy,
    );
    assertEquals(client(proxy, "198.51.100.1, 203.0.113.9", 1), "203.0.113.9");
  }
  assertEquals(client("192.168.2.5"), "192.168.2.5");
});

Deno.test("TRUSTED_PROXIES=0 ignores the header even from a local peer", () => {
  assertEquals(client("192.168.2.5", "198.51.100.1", 0), "192.168.2.5");
  assertEquals(client("127.0.0.1", "198.51.100.1", 0), "127.0.0.1");
});

Deno.test("a chain of proxies: the n-th entry from the right is the client", () => {
  // CDN → local proxy → node: the local proxy appended the CDN edge address.
  const chain = "198.51.100.1, 203.0.113.9";
  assertEquals(client("127.0.0.1", chain, 2), "198.51.100.1");
  // A forged entry in front of the real one does not count.
  assertEquals(
    client("127.0.0.1", "192.0.2.66, 198.51.100.1, 203.0.113.9", 2),
    "198.51.100.1",
  );
  // Fewer entries than hops: the leftmost.
  assertEquals(client("127.0.0.1", "198.51.100.1", 3), "198.51.100.1");
});

Deno.test("forwarded entries with ports, brackets or garbage", () => {
  assertEquals(client("127.0.0.1", "198.51.100.1:5555"), "198.51.100.1");
  assertEquals(
    client("127.0.0.1", "[2001:db8:1:2::7]:443"),
    "2001:db8:1:2::/64",
  );
  // The entry at the hop position is not an address: the peer is the client.
  assertEquals(client("127.0.0.1", "198.51.100.1, unknown"), "127.0.0.1");
  assertEquals(client("127.0.0.1", "unknown, _hidden"), "127.0.0.1");
  assertEquals(client("127.0.0.1", "unknown"), "127.0.0.1");
  // An unknown entry further left does not matter.
  assertEquals(client("127.0.0.1", "unknown, 198.51.100.1"), "198.51.100.1");
});

Deno.test("a non-address entry keeps its position and never shifts the hops", () => {
  // The proxy nearest the node appended `unknown`; the forged entry stays out.
  const chain = "192.0.2.66, unknown, 203.0.113.9";
  assertEquals(client("127.0.0.1", chain, 2), "127.0.0.1");
  assertEquals(client("127.0.0.1", chain, 3), "192.0.2.66");
  assertEquals(client("127.0.0.1", chain, 1), "203.0.113.9");
  assertEquals(client("127.0.0.1", "192.0.2.66, _hidden", 1), "127.0.0.1");
  // The leftmost is taken with fewer entries, and it must be an address too.
  assertEquals(client("127.0.0.1", "unknown, 203.0.113.9", 3), "127.0.0.1");
  // An empty item is a position as well.
  assertEquals(
    client("127.0.0.1", "192.0.2.66, , 203.0.113.9", 2),
    "127.0.0.1",
  );
  assertEquals(
    client("127.0.0.1", "192.0.2.66, , 203.0.113.9", 3),
    "192.0.2.66",
  );
  assertEquals(client("127.0.0.1", "203.0.113.9,", 1), "127.0.0.1");
  // Well-formed chains are unchanged.
  assertEquals(
    client("127.0.0.1", "192.0.2.66, 198.51.100.1, 203.0.113.9", 2),
    "198.51.100.1",
  );
});

Deno.test("a header at the hop position that is no address counts as unforwarded", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    const from = (peerAddress: string, header?: string) => {
      const r = request(header);
      rememberClient(r, peer(peerAddress));
      noteLimitReached(r);
    };
    from("172.21.0.1", "198.51.100.1, unknown");
    from("172.22.0.1", "   ");
    from("172.23.0.1", "198.51.100.1, , ");
    from("172.24.0.1", "198.51.100.1");
  } finally {
    console.warn = original;
  }
  assertEquals(warnings.length, 3);
  assertEquals(warnings.some((w) => w.includes("172.24.0.1")), false);
});

Deno.test("IPv6 clients are keyed by their /64", () => {
  const a = client("2001:db8:1:2:aaaa::1");
  const b = client("2001:db8:1:2:bbbb:cccc:dddd:eeee");
  assertEquals(a, "2001:db8:1:2::/64");
  assertEquals(a, b);
  assertEquals(client("2001:db8:1:3::1"), "2001:db8:1:3::/64");
  assertEquals(
    client("127.0.0.1", "2001:0db8:0001:0002:0000:0000:0000:0001"),
    "2001:db8:1:2::/64",
  );
  assertEquals(clientKey("::1"), "0:0:0:0::/64");
  // A NAT64 address is keyed by the IPv4 address inside it.
  assertEquals(clientKey("64:ff9b::192.0.2.1"), "192.0.2.1");
  assertEquals(clientKey("64:ff9b::c000:201"), "192.0.2.1");
  assertEquals(clientKey("64:ff9b:1::c000:201"), "64:ff9b:1:0::/64");
  assertEquals(clientKey("::192.0.2.1"), "0:0:0:0::/64");
  assertEquals(clientKey("198.51.100.1"), "198.51.100.1");
  assertEquals(clientKey("not:an::address::"), "not:an::address::");
});

Deno.test("local addresses are recognised", () => {
  for (
    const a of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "fd00::1",
      "fe80::1",
      "::1",
      "0:0:0:0:0:0:0:1",
    ]
  ) {
    assertEquals(isLocalAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "172.32.0.1", "2001:db8::1", "fec0::1", "::2"]) {
    assertEquals(isLocalAddress(a), false, a);
  }
});

Deno.test("a limit reached by a local peer without X-Forwarded-For is reported once", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    const unforwarded = () => {
      const r = request();
      rememberClient(r, peer("172.20.0.9"));
      return r;
    };
    noteLimitReached(unforwarded());
    noteLimitReached(unforwarded());
    // A forwarded or a public client is not a proxy problem.
    const forwarded = request("198.51.100.1");
    rememberClient(forwarded, peer("172.20.0.9"));
    noteLimitReached(forwarded);
    const direct = request();
    rememberClient(direct, peer("203.0.113.7"));
    noteLimitReached(direct);
  } finally {
    console.warn = original;
  }
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("172.20.0.9"), true);
  assertEquals(warnings[0].includes("X-Forwarded-For"), true);
});

Deno.test("IPv4-mapped IPv6 addresses are the IPv4 address in every spelling", () => {
  for (
    const a of [
      "::ffff:1.2.3.4",
      "::ffff:102:304",
      "::FFFF:0102:0304",
      "0:0:0:0:0:ffff:102:304",
      "0000:0000:0000:0000:0000:ffff:0102:0304",
      "0:0::ffff:1.2.3.4",
    ]
  ) {
    assertEquals(clientKey(a), "1.2.3.4", a);
    assertEquals(client(a), "1.2.3.4", a);
    assertEquals(client("127.0.0.1", a), "1.2.3.4", a);
  }
  assertEquals(client("::ffff:102:304"), "1.2.3.4");
  assertEquals(client("127.0.0.1", "[::ffff:102:304]:443"), "1.2.3.4");
  // It is not the loopback /64, and `::1` stays IPv6.
  assertEquals(clientKey("::1"), "0:0:0:0::/64");
  assertEquals(clientKey("::ffff:0:102:304"), "0:0:0:0::/64");
});

Deno.test("a mapped local address is local, and a proxy in any spelling is trusted", () => {
  for (
    const a of [
      "::ffff:7f00:1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:FFFF:7F00:0001",
      "::ffff:a00:2",
      "::ffff:c0a8:105",
    ]
  ) {
    assertEquals(isLocalAddress(a), true, a);
  }
  for (const a of ["::ffff:808:808", "::ffff:ac20:1", "::ffff:0:7f00:1"]) {
    assertEquals(isLocalAddress(a), false, a);
  }
  assertEquals(client("::ffff:7f00:1", "198.51.100.1"), "198.51.100.1");
  assertEquals(client("::ffff:808:808", "198.51.100.1"), "8.8.8.8");
});

Deno.test("NAT64 addresses are keyed by the IPv4 inside but are never local", () => {
  for (
    const a of ["64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b::a00:1"]
  ) {
    assertEquals(isLocalAddress(a), false, a);
  }
  // So a NAT64 peer cannot name its client with the header.
  assertEquals(
    client("64:ff9b::7f00:1", "198.51.100.1"),
    "127.0.0.1",
  );
  assertEquals(client("64:ff9b::c000:201"), "192.0.2.1");
});
