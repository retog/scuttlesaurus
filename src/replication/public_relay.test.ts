/**
 * Tests of the relay-list SSRF guard.
 * @module
 */
import { assertEquals } from "@std/assert";
import { isPublicRelayUrl } from "./public_relay.ts";

const PUBLIC = [
  "wss://relay.damus.io/",
  "wss://nos.lol",
  "wss://8.8.8.8/",
  "wss://172.15.0.1/",
  "wss://172.32.0.1/",
  "wss://100.63.0.1/",
  "wss://198.17.0.1/",
  "wss://[2606:4700::1111]/",
  "wss://relay.example.com:8443/path",
  "wss://localhost.example.com/",
];

const NOT_PUBLIC = [
  "ws://relay.damus.io/",
  "wss://localhost/",
  "wss://LOCALHOST:7777/",
  "wss://localhost./",
  "wss://a.localhost/",
  "wss://printer.local/",
  "wss://db.internal/",
  "wss://nas.lan/",
  "wss://x.home.arpa/",
  "wss://intranet/",
  "wss://0.0.0.0/",
  "wss://0.1.2.3/",
  "wss://10.0.0.5/",
  "wss://100.64.0.1/",
  "wss://100.127.255.255/",
  "wss://127.0.0.1/",
  "wss://127.1/",
  "wss://169.254.169.254/latest/meta-data",
  "wss://172.16.0.1/",
  "wss://172.31.255.255/",
  "wss://192.168.1.1/",
  "wss://198.18.0.1/",
  "wss://198.19.255.255/",
  "wss://224.0.0.1/",
  "wss://255.255.255.255/",
  "wss://2130706433/",
  "wss://[::1]/",
  "wss://[::]/",
  "wss://[fc00::1]/",
  "wss://[fd12:3456::1]/",
  "wss://[fe80::1]/",
  "wss://[febf::1]/",
  "wss://[ff02::1]/",
  "wss://[::ffff:127.0.0.1]/",
  "wss://[::ffff:10.1.2.3]/",
  "wss://[64:ff9b::7f00:1]/",
  "not a url",
  "",
];

Deno.test("public wss relays are accepted", () => {
  for (const url of PUBLIC) assertEquals(isPublicRelayUrl(url), true, url);
});

Deno.test("plain ws, local names and non-public addresses are refused", () => {
  for (const url of NOT_PUBLIC) assertEquals(isPublicRelayUrl(url), false, url);
});

Deno.test("an IPv4-mapped public IPv6 address is public", () => {
  assertEquals(isPublicRelayUrl("wss://[::ffff:8.8.8.8]/"), true);
});
