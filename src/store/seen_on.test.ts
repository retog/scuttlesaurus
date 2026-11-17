/**
 * `nostr:seenOn` for events that are already stored: one more triple per
 * relay, checked against the event's id, capped, and written with the group
 * commit.
 */
import { assertEquals } from "@std/assert";
import { MemoryTripleStore } from "../testing/mod.ts";
import type { EventStore, NostrEvent } from "../types.ts";
import { MAX_SEEN_RELAYS } from "./commit_plan.ts";
import { createEventStore } from "./event_store.ts";
import { config, CountingStore, identities, sign } from "./test_util.ts";

const [alice, bob] = identities(2);
const relay = (n: number | string) =>
  `wss://relay${String(n).toLowerCase()}.example.com/`;

async function withStore(
  fn: (
    store: EventStore,
    counting: CountingStore,
    memory: MemoryTripleStore,
  ) => Promise<void>,
): Promise<void> {
  const memory = new MemoryTripleStore();
  const counting = new CountingStore(memory);
  const store = await createEventStore(counting, config());
  try {
    await fn(store, counting, memory);
  } finally {
    await store.close();
  }
}

/** The relays an author's events were seen on, with counts. */
async function scoresOf(store: EventStore, event: NostrEvent) {
  return (await store.relayScores([event.pubkey])).get(event.pubkey);
}

Deno.test("seenOn: a stored event received from another relay gets that relay", async () => {
  await withStore(async (store) => {
    const note = sign(alice, 1, { content: "hi" });
    const seen: [string | undefined, boolean][] = [];
    store.subscribe((_, info) => seen.push([info.seenOn, info.stored]));
    assertEquals(await store.add(note, { seenOn: relay("A") }), {
      status: "stored",
    });
    assertEquals(await store.add(note, { seenOn: relay("B") }), {
      status: "duplicate",
    });
    assertEquals(await store.add(note, { seenOn: relay("B") }), {
      status: "duplicate",
    });
    assertEquals(await store.add(note), { status: "duplicate" });
    assertEquals(
      await scoresOf(store, note),
      new Map([[relay("A"), 1], [relay("B"), 1]]),
    );
    // Subscribers hear of the event once.
    assertEquals(seen, [[relay("A"), true]]);
  });
});

Deno.test("seenOn: an event published to this node gets its first relay later", async () => {
  await withStore(async (store) => {
    const note = sign(alice, 1, { content: "mine" });
    await store.add(note);
    assertEquals((await store.relayScores([alice.pubkey])).size, 0);
    await store.add(note, { seenOn: relay("A"), verified: true });
    assertEquals(
      (await store.relayScores([alice.pubkey])).get(alice.pubkey),
      new Map([[relay("A"), 1]]),
    );
  });
});

Deno.test("seenOn: an id alone earns nothing, the event must match its id", async () => {
  await withStore(async (store, counting) => {
    const note = sign(alice, 1, { content: "real" });
    await store.add(note, { seenOn: relay("A") });
    const inserts = counting.inserts;
    // The id of a stored event on content nobody signed, with and without the
    // `verified` flag the replicator sets.
    for (const verified of [false, true]) {
      const forged = { ...note, content: "forged" };
      const result = await store.add(forged, {
        seenOn: relay("B"),
        verified,
      });
      assertEquals(result.status, "rejected");
    }
    const bareId = { id: note.id } as unknown as NostrEvent;
    assertEquals(
      (await store.add(bareId, { seenOn: relay("B") })).status,
      "rejected",
    );
    assertEquals(counting.inserts, inserts);
    assertEquals(
      (await store.relayScores([alice.pubkey])).get(alice.pubkey),
      new Map([[relay("A"), 1]]),
    );
    // The id matches, so it is the stored event: its signature is not
    // verified a second time (this one would not verify), the relay counts.
    const resigned = { ...note, sig: "0".repeat(128) };
    assertEquals(
      (await store.add(resigned, { seenOn: relay("B") })).status,
      "duplicate",
    );
    assertEquals(
      (await store.relayScores([alice.pubkey])).get(alice.pubkey)?.get(
        relay("B"),
      ),
      1,
    );
  });
});

Deno.test("seenOn: at most four relays per event, also across a restart", async () => {
  const memory = new MemoryTripleStore();
  let store = await createEventStore(new CountingStore(memory), config());
  const note = sign(alice, 1, { content: "popular" });
  const other = sign(alice, 1, { content: "other" });
  await store.add(other, { seenOn: relay("A") });
  for (let n = 1; n <= 7; n++) {
    await store.add(note, { seenOn: relay(n) });
  }
  const expected = new Map(
    Array.from({ length: MAX_SEEN_RELAYS }, (_, i) => [relay(i + 1), 1]),
  );
  expected.set(relay("A"), 1);
  assertEquals(
    (await store.relayScores([alice.pubkey])).get(alice.pubkey),
    expected,
  );
  assertEquals(MAX_SEEN_RELAYS, 4);

  // A new process knows nothing of what was recorded; the graph decides.
  store = await createEventStore(new CountingStore(memory), config());
  await store.add(note, { seenOn: relay(9) });
  assertEquals(
    (await store.relayScores([alice.pubkey])).get(alice.pubkey)?.has(relay(9)),
    false,
  );
  await store.add(other, { seenOn: relay(9) });
  assertEquals(
    (await store.relayScores([alice.pubkey])).get(alice.pubkey)?.get(relay(9)),
    1,
  );
  await store.close();
});

Deno.test("seenOn: a pair is written once per process, and in the group commit", async () => {
  await withStore(async (store, counting) => {
    const notes = Array.from(
      { length: 50 },
      (_, i) => sign(alice, 1, { content: `n${i}` }),
    );
    await Promise.all(notes.map((n) => store.add(n, { seenOn: relay("A") })));
    const inserts = counting.inserts;
    // All fifty again from another relay: one insert, not fifty.
    await Promise.all(notes.map((n) => store.add(n, { seenOn: relay("B") })));
    assertEquals(counting.inserts, inserts + 1);
    // The same pairs once more: nothing is read or written.
    const calls = counting.calls;
    await Promise.all(notes.map((n) => store.add(n, { seenOn: relay("B") })));
    await Promise.all(notes.map((n) => store.add(n, { seenOn: relay("A") })));
    assertEquals(counting.calls, calls);
    assertEquals(
      (await store.relayScores([alice.pubkey])).get(alice.pubkey),
      new Map([[relay("A"), 50], [relay("B"), 50]]),
    );
  });
});

Deno.test("seenOn: the same event from two relays in one burst records both", async () => {
  await withStore(async (store) => {
    const note = sign(bob, 1, { content: "twice" });
    const results = await Promise.all(
      [relay("A"), relay("B"), relay("A")].map((r) =>
        store.add(note, { seenOn: r })
      ),
    );
    assertEquals(results.map((r) => r.status), [
      "stored",
      "duplicate",
      "duplicate",
    ]);
    assertEquals(
      (await store.relayScores([bob.pubkey])).get(bob.pubkey),
      new Map([[relay("A"), 1], [relay("B"), 1]]),
    );
  });
});

Deno.test("seenOn: a retracted event keeps no credit, an unusable relay is ignored", async () => {
  await withStore(async (store, counting) => {
    const note = sign(alice, 1, { content: "gone" });
    await store.add(note, { seenOn: relay("A") });
    const inserts = counting.inserts;
    assertEquals(
      (await store.add(note, { seenOn: "not a url" })).status,
      "duplicate",
    );
    assertEquals(counting.inserts, inserts);
    await store.add(sign(alice, 5, { tags: [["e", note.id]] }));
    await store.add(note, { seenOn: relay("B") });
    assertEquals((await store.relayScores([alice.pubkey])).size, 0);
  });
});
