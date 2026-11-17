/**
 * Tests of the Nostr Connect replay buffer: the window, the bounds and the
 * filter semantics, with a controlled clock.
 * @module
 */
import { assertEquals } from "@std/assert";
import type { NostrEvent } from "../types.ts";
import {
  INTEREST_LINGER_MS,
  MAX_PER_PUBKEY,
  MAX_TOTAL,
  MAX_TOTAL_BYTES,
  MAX_UNWATCHED,
  REPLAY_WINDOW_MS,
  ReplayBuffer,
} from "./replay_buffer.ts";

let counter = 0;
const hex = (n: number) => n.toString(16).padStart(64, "0");

function event(to: string, createdAt = 1000, kind = 24133): NostrEvent {
  counter++;
  return {
    id: hex(counter),
    pubkey: hex(999),
    created_at: createdAt,
    kind,
    tags: [["p", to]],
    content: "x",
    sig: "0".repeat(128),
  };
}

Deno.test("events are replayed inside the window and not after it", () => {
  let now = 0;
  const buffer = new ReplayBuffer(() => now);
  const e = event(hex(1));
  buffer.add(e);
  now = REPLAY_WINDOW_MS - 1;
  assertEquals(buffer.match([{ "#p": [hex(1)] }]), [e]);
  now = REPLAY_WINDOW_MS + 1;
  assertEquals(buffer.match([{ "#p": [hex(1)] }]), []);
  assertEquals(buffer.size, 0);
});

Deno.test("at most 20 events are kept per p-tagged pubkey, oldest first dropped", () => {
  const buffer = new ReplayBuffer(() => 0);
  const events = Array.from(
    { length: MAX_PER_PUBKEY + 5 },
    (_, i) => event(hex(1), 1000 + i),
  );
  for (const e of events) buffer.add(e);
  const kept = buffer.match([{ "#p": [hex(1)] }]);
  assertEquals(kept.length, MAX_PER_PUBKEY);
  assertEquals(kept[0].id, events.at(-1)!.id);
  assertEquals(kept.at(-1)!.id, events[5].id);
  // Another recipient is not affected.
  buffer.add(event(hex(2)));
  assertEquals(buffer.match([{ "#p": [hex(2)] }]).length, 1);
});

Deno.test("the total is bounded and the oldest are dropped first", () => {
  const buffer = new ReplayBuffer(() => 0);
  const recipients = Array.from(
    { length: MAX_TOTAL / MAX_PER_PUBKEY + 1 },
    (_, i) => hex(100000 + i),
  );
  buffer.watch(recipients);
  const first = event(recipients[0]);
  buffer.add(first);
  for (const to of recipients) {
    for (let i = 0; i < MAX_PER_PUBKEY; i++) buffer.add(event(to));
  }
  assertEquals(buffer.size, MAX_TOTAL);
  assertEquals(buffer.match([{ ids: [first.id] }]), []);
});

Deno.test("the bytes held are bounded", () => {
  const buffer = new ReplayBuffer(() => 0);
  const recipients = Array.from({ length: 40 }, (_, i) => hex(200000 + i));
  buffer.watch(recipients);
  for (const to of recipients) {
    for (let i = 0; i < MAX_PER_PUBKEY; i++) {
      buffer.add({ ...event(to), content: "x".repeat(60_000) });
    }
  }
  assertEquals(buffer.bytes <= MAX_TOTAL_BYTES, true);
  assertEquals(buffer.size < 40 * MAX_PER_PUBKEY, true);
});

Deno.test("a flood to pubkeys nobody asked for only displaces itself", () => {
  const buffer = new ReplayBuffer(() => 0);
  buffer.watch([hex(1)]);
  const wanted = event(hex(1));
  buffer.add(wanted);
  const stray = event(hex(300000));
  buffer.add(stray);
  for (let i = 1; i <= 3 * MAX_UNWATCHED; i++) {
    buffer.add(event(hex(300000 + i)));
  }
  assertEquals(buffer.size, MAX_UNWATCHED + 1);
  assertEquals(buffer.match([{ "#p": [hex(1)] }]), [wanted]);
  assertEquals(buffer.match([{ ids: [stray.id] }]), []);
});

Deno.test("only the first few p tags count, however many an event has", () => {
  const buffer = new ReplayBuffer(() => 0);
  const e = event(hex(1));
  e.tags = Array.from({ length: 900 }, (_, i) => ["p", hex(400000 + i)]);
  buffer.add(e);
  assertEquals(buffer.match([{ "#p": [hex(400000)] }]), [e]);
  assertEquals(buffer.match([{ "#p": [hex(400899)] }]), []);
});

Deno.test("interest lasts while a connection watches and lingers after it", () => {
  let now = 0;
  const buffer = new ReplayBuffer(() => now);
  const release = buffer.watch([hex(1)]);
  now = 10 * INTEREST_LINGER_MS;
  // Still watched: a full set of unwatched events does not displace it.
  const kept = event(hex(1));
  buffer.add(kept);
  release();
  release();
  now += INTEREST_LINGER_MS - 1;
  const lingering = event(hex(1));
  buffer.add(lingering);
  for (let i = 0; i <= MAX_UNWATCHED; i++) buffer.add(event(hex(500000 + i)));
  assertEquals(buffer.match([{ "#p": [hex(1)] }]), [lingering]);
  now += 2;
  // Interest is over: the next one is an unwatched event like any other.
  const late = event(hex(1));
  buffer.add(late);
  for (let i = 0; i <= MAX_UNWATCHED; i++) buffer.add(event(hex(600000 + i)));
  assertEquals(
    buffer.match([{ "#p": [hex(1)] }]).some((e) => e.id === late.id),
    false,
  );
});

Deno.test("since, until and limit of each filter are honoured; duplicates are ignored", () => {
  const buffer = new ReplayBuffer(() => 0);
  const a = event(hex(1), 100);
  const b = event(hex(1), 200);
  const c = event(hex(1), 300);
  for (const e of [a, b, c, c]) buffer.add(e);
  assertEquals(buffer.size, 3);
  assertEquals(buffer.match([{ "#p": [hex(1)], since: 200 }]), [c, b]);
  assertEquals(buffer.match([{ "#p": [hex(1)], until: 200 }]), [b, a]);
  assertEquals(buffer.match([{ "#p": [hex(1)], limit: 1 }]), [c]);
  assertEquals(buffer.match([{ "#p": [hex(1)], limit: 0 }]), []);
  assertEquals(buffer.match([{ kinds: [1] }]), []);
});
