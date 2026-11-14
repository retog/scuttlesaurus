/// <reference lib="deno.ns" />
/**
 * Tests of the pure helpers of `remote_signer.ts`: relay choice and input,
 * and the permissions requested in the `nostrconnect://` link (NIP-46).
 * @module
 */
import { assertEquals } from "@std/assert";
import {
  chooseRelay,
  isLoopbackHost,
  normalizeRelayInput,
  REQUESTED_PERMISSIONS,
  SIGNED_KINDS,
} from "./remote_signer.ts";

Deno.test("loopback hosts are recognized, others are not", () => {
  for (
    const host of [
      "localhost",
      "localhost:7777",
      "127.0.0.1:7881",
      "127.1.2.3",
      "[::1]:7777",
      "node.localhost",
    ]
  ) assertEquals(isLoopbackHost(host), true, host);
  for (
    const host of ["192.168.1.5:7777", "node.example.org", "10.0.0.2", "::2"]
  ) assertEquals(isLoopbackHost(host), false, host);
});

Deno.test("the node's relay is the default unless the page is on localhost", () => {
  assertEquals(
    chooseRelay("wss://node.example.org/", "node.example.org").relay,
    "wss://node.example.org/",
  );
  assertEquals(
    chooseRelay("ws://192.168.1.5:7777/", "192.168.1.5:7777").relay,
    "ws://192.168.1.5:7777/",
  );
  const local = chooseRelay("ws://127.0.0.1:7777/", "127.0.0.1:7777");
  assertEquals(local.relay, undefined);
  assertEquals(typeof local.reason, "string");
  // A public relay address on a page opened as localhost is still unreachable
  // for the phone, because the page's own origin decides.
  assertEquals(
    chooseRelay("wss://node.example.org/", "localhost:7777").relay,
    undefined,
  );
  assertEquals(chooseRelay(undefined, "node.example.org").relay, undefined);
});

Deno.test("relay input is normalized to ws or wss", () => {
  assertEquals(
    normalizeRelayInput("wss://relay.nsec.app"),
    "wss://relay.nsec.app/",
  );
  assertEquals(normalizeRelayInput("relay.nsec.app"), "wss://relay.nsec.app/");
  assertEquals(normalizeRelayInput("https://a.example/x"), "wss://a.example/x");
  assertEquals(
    normalizeRelayInput("ws://127.0.0.1:7881/"),
    "ws://127.0.0.1:7881/",
  );
  for (
    const bad of ["", "  ", "ftp://a.example", "wss://", "wss://u:p@a.example/"]
  ) {
    assertEquals(normalizeRelayInput(bad), undefined, bad);
  }
});

Deno.test("the link asks to sign exactly the kinds the client signs", () => {
  assertEquals(
    REQUESTED_PERMISSIONS,
    SIGNED_KINDS.map((kind) => `sign_event:${kind}`),
  );
  for (
    const kind of [1, 7, 6, 5, 3, 0, 10002, 30023, 30024, 1111, 24242, 27235]
  ) {
    assertEquals(SIGNED_KINDS.includes(kind), true, `kind ${kind}`);
  }
});
