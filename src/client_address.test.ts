import { assertEquals } from "@std/assert";
import {
  clientAddress,
  isLocalAddress,
  rememberClient,
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

Deno.test("the peer address is the client, and a public peer cannot forge another", () => {
  const plain = request();
  rememberClient(plain, peer("203.0.113.7"));
  assertEquals(clientAddress(plain), "203.0.113.7");

  const forged = request("198.51.100.1");
  rememberClient(forged, peer("203.0.113.7"));
  assertEquals(clientAddress(forged), "203.0.113.7");

  assertEquals(clientAddress(request()), UNKNOWN_CLIENT);
});

Deno.test("behind a local proxy the last forwarded address is the client", () => {
  for (const proxy of ["127.0.0.1", "::1", "172.18.0.3", "::ffff:10.0.0.2"]) {
    const forwarded = request("198.51.100.1, 203.0.113.9");
    rememberClient(forwarded, peer(proxy));
    assertEquals(clientAddress(forwarded), "203.0.113.9", proxy);
  }
  const direct = request();
  rememberClient(direct, peer("192.168.2.5"));
  assertEquals(clientAddress(direct), "192.168.2.5");
});

Deno.test("local addresses are recognised", () => {
  for (
    const a of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "fd00::1", "fe80::1"]
  ) {
    assertEquals(isLocalAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "172.32.0.1", "2001:db8::1"]) {
    assertEquals(isLocalAddress(a), false, a);
  }
});
