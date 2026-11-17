import { assertEquals, assertThrows } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { finalizeEvent, generateSecretKey } from "@nostr/tools/pure";
import {
  MAX_AUTHORIZATION_LENGTH,
  NostrAuthorizationError,
  parseNostrAuthorization,
} from "./nostr_auth.ts";

const header = (value: unknown) =>
  "Nostr " + encodeBase64(new TextEncoder().encode(JSON.stringify(value)));

const signed = () =>
  finalizeEvent(
    { kind: 27235, created_at: 1, tags: [], content: "" },
    generateSecretKey(),
  );

Deno.test("a signed event in the header is returned", () => {
  const event = signed();
  assertEquals(parseNostrAuthorization(header(event)).id, event.id);
});

Deno.test("missing, oversized, malformed and unsigned headers are refused", () => {
  const event = signed();
  const { sig: _sig, ...unsigned } = event;
  const { id: _id, ...withoutId } = event;
  const cases: [string | null, string][] = [
    [null, "missing"],
    ["Nostr " + "A".repeat(MAX_AUTHORIZATION_LENGTH), "too large"],
    ["Bearer abc", "not a Nostr event"],
    ["Nostr !!!", "base64"],
    [header(unsigned), "signature"],
    [header(withoutId), "signature"],
    [header({ ...event, content: "changed" }), "signature"],
    [header({ ...event, sig: "zz" }), "signature"],
    [header({ ...event, pubkey: "00" }), "signature"],
    [header(null), "signature"],
  ];
  for (const [value, message] of cases) {
    assertThrows(
      () => parseNostrAuthorization(value),
      NostrAuthorizationError,
      message,
    );
  }
});
