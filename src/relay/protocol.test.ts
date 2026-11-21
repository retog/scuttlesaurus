/**
 * Unit tests for the relay's wire-level helpers.
 * @module
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  clampLimit,
  eventIdOf,
  isSubscriptionId,
  MAX_MESSAGE_BYTES,
  parseFilters,
  parseFrame,
  parseSignedEvent,
  withMachinePrefix,
} from "./protocol.ts";
import { keyPair, signedEvent } from "./test_helpers.ts";

Deno.test("parseFrame accepts a text frame holding a JSON array", () => {
  const result = parseFrame('["REQ","a",{"kinds":[1]}]');
  assertEquals(result, { ok: true, parts: ["REQ", "a", { kinds: [1] }] });
});

Deno.test("parseFrame rejects binary frames, bad JSON, non-arrays and oversize frames", () => {
  const notices = [
    parseFrame(new Uint8Array([1, 2])),
    parseFrame("not json"),
    parseFrame('{"kind":1}'),
    parseFrame(`["NOTICE","${"x".repeat(MAX_MESSAGE_BYTES)}"]`),
  ];
  for (const result of notices) {
    assert(!result.ok);
    assert(result.notice.length > 0);
  }
});

Deno.test("parseFrame counts bytes, not characters", () => {
  // 'é' is two bytes in UTF-8; this frame is just over the limit in bytes.
  const padding = "é".repeat(MAX_MESSAGE_BYTES / 2);
  assertFalse(parseFrame(`["X","${padding}"]`).ok);
});

Deno.test("subscription ids must be 1 to 64 characters", () => {
  assertFalse(isSubscriptionId(""));
  assertFalse(isSubscriptionId("x".repeat(65)));
  assertFalse(isSubscriptionId(7));
  assert(isSubscriptionId("x"));
  assert(isSubscriptionId("x".repeat(64)));
});

Deno.test("parseFilters enforces the filter count and object shape", () => {
  assertEquals(parseFilters([]), { error: "at least one filter is required" });
  assertEquals(
    parseFilters(Array.from({ length: 11 }, () => ({}))),
    { error: "at most 10 filters are allowed" },
  );
  assertEquals(parseFilters([[1]]), {
    error: "each filter must be a JSON object",
  });
  assertEquals(parseFilters(Array.from({ length: 10 }, () => ({}))), {
    filters: Array.from({ length: 10 }, () => ({})),
  });
});

Deno.test("clampLimit lowers only limits above the maximum", () => {
  assertEquals(clampLimit({ limit: 900 }, 500), { limit: 500 });
  assertEquals(clampLimit({ limit: 5 }, 500), { limit: 5 });
  assertEquals(clampLimit({ kinds: [1] }, 500), { kinds: [1] });
});

Deno.test("withMachinePrefix keeps known prefixes and adds invalid: otherwise", () => {
  assertEquals(withMachinePrefix("blocked: x"), "blocked: x");
  assertEquals(withMachinePrefix("rate-limited: x"), "rate-limited: x");
  assertEquals(withMachinePrefix("bad event"), "invalid: bad event");
});

Deno.test("eventIdOf only returns lowercase 64-character hex ids", () => {
  const key = keyPair();
  const event = signedEvent(key);
  assertEquals(eventIdOf(event), event.id);
  assertEquals(eventIdOf({ id: event.id.toUpperCase() }), undefined);
  assertEquals(eventIdOf({ id: "abc" }), undefined);
  assertEquals(eventIdOf("not an object"), undefined);
});

Deno.test("parseSignedEvent accepts valid events and rejects tampered ones", () => {
  const key = keyPair();
  const event = signedEvent(key, { content: "original" });
  // Copies go through JSON, as frames do: a spread would keep the
  // Symbol(verified) cache that nostr-tools sets on signed events.
  const copy = (changes: Record<string, unknown>) =>
    JSON.parse(JSON.stringify({ ...event, ...changes }));
  assert("event" in parseSignedEvent(copy({})));
  assertEquals(parseSignedEvent(copy({ content: "changed" })), {
    error: "id or signature does not verify",
  });
  assertEquals(parseSignedEvent(copy({ sig: "00".repeat(64) })), {
    error: "id or signature does not verify",
  });
  assertEquals(parseSignedEvent({ id: event.id }), {
    error: "malformed event",
  });
});
