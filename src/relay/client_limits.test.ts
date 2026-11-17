import { assert, assertEquals } from "@std/assert";
import { UNKNOWN_CLIENT } from "../client_address.ts";
import {
  ClientLimits,
  ClientLimitsTable,
  MAX_CONNECTIONS_PER_CLIENT,
} from "./client_limits.ts";
import { NOSTR_CONNECT_BURST, NOSTR_CONNECT_PER_SECOND } from "./protocol.ts";

Deno.test("the connections of one address share one allowance, another address has its own", () => {
  const table = new ClientLimitsTable();
  const first = table.admit("203.0.113.1")!;
  const second = table.admit("203.0.113.1")!;
  assert(first === second);
  assertEquals(first.connections, 2);
  for (let i = 0; i < NOSTR_CONNECT_BURST; i++) {
    assert(first.takeConnectToken());
  }
  // A second connection does not bring a second burst.
  assertEquals(second.takeConnectToken(), false);
  assert(table.admit("203.0.113.2")!.takeConnectToken());
});

Deno.test("an address holds a bounded number of connections", () => {
  const table = new ClientLimitsTable();
  const admitted = Array.from(
    { length: MAX_CONNECTIONS_PER_CLIENT },
    () => table.admit("203.0.113.1")!,
  );
  assertEquals(table.admit("203.0.113.1"), undefined);
  table.release(admitted[0]);
  assert(table.admit("203.0.113.1"));
  // Unknown addresses (no connection information) are not pooled.
  assert(table.admit(UNKNOWN_CLIENT) !== table.admit(UNKNOWN_CLIENT));
});

Deno.test("the token bucket refills with time", () => {
  let now = 0;
  const limits = new ClientLimits(() => now);
  for (let i = 0; i < NOSTR_CONNECT_BURST; i++) limits.takeConnectToken();
  assertEquals(limits.takeConnectToken(), false);
  now += 1000;
  let granted = 0;
  while (limits.takeConnectToken()) granted++;
  assertEquals(granted, NOSTR_CONNECT_PER_SECOND);
});
