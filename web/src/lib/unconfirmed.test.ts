/// <reference lib="deno.ns" />
/** Retrying an unconfirmed publication resends the same signed event. */
import { assertEquals } from "@std/assert";
import type { Event } from "@nostr/tools/core";
import { UnconfirmedEvents } from "./unconfirmed.ts";

const event = (id: string, content = "hi", created_at = 1): Event => ({
  id,
  pubkey: "a".repeat(64),
  kind: 1,
  content,
  tags: [["t", "x"]],
  created_at,
  sig: "s",
});

Deno.test("unconfirmed: the same content finds the same signed event", () => {
  const kept = new UnconfirmedEvents();
  kept.keep(event("1"));
  const template = {
    kind: 1,
    content: "hi",
    tags: [["t", "x"]],
    created_at: 9,
  };
  assertEquals(kept.find("a".repeat(64), template)?.id, "1");
  assertEquals(kept.find("b".repeat(64), template), undefined);
  assertEquals(
    kept.find("a".repeat(64), { ...template, content: "ho" }),
    undefined,
  );
  assertEquals(kept.find("a".repeat(64), { ...template, tags: [] }), undefined);
});

Deno.test("unconfirmed: forgotten and expired events are not offered", () => {
  let now = 0;
  const kept = new UnconfirmedEvents(() => now);
  const template = {
    kind: 1,
    content: "hi",
    tags: [["t", "x"]],
    created_at: 9,
  };
  kept.keep(event("1"));
  kept.forget(event("2"));
  assertEquals(kept.find("a".repeat(64), template)?.id, "1");
  kept.forget(event("1"));
  assertEquals(kept.find("a".repeat(64), template), undefined);
  kept.keep(event("3"));
  now = 2 * 60 * 60_000;
  assertEquals(kept.find("a".repeat(64), template), undefined);
});
