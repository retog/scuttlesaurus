import { assertEquals } from "@std/assert";
import { createEventStore } from "../store/event_store.ts";
import { config, CountingStore, identities, sign } from "../store/test_util.ts";
import { MemoryTripleStore } from "../testing/mod.ts";
import { Ingest } from "./ingest.ts";
import { planRelays } from "./plan.ts";

const [alice] = identities(1);

const BOOTSTRAP = "wss://bootstrap.example.com/";
// Listed by the author; the first is the one they really publish to. By URL
// order alone the second would win a tie.
const OWN = "wss://own-relay.example.com/";
const OTHER = "wss://another-relay.example.com/";

async function withIngest(
  fn: (
    ingest: Ingest,
    store: Awaited<ReturnType<typeof createEventStore>>,
    counting: CountingStore,
  ) => Promise<void>,
): Promise<void> {
  const counting = new CountingStore(new MemoryTripleStore());
  const store = await createEventStore(counting, config());
  try {
    await fn(new Ingest(store), store, counting);
  } finally {
    await store.close();
  }
}

Deno.test("ingest: a known event from another relay is recorded, not verified again", async () => {
  await withIngest(async (ingest, store) => {
    const note = sign(alice, 1, { content: "first from the fast relay" });
    assertEquals(await ingest.handle(BOOTSTRAP, note), "stored");
    assertEquals(await ingest.handle(OWN, note), "known");
    assertEquals(
      (await store.relayScores([alice.pubkey])).get(alice.pubkey),
      new Map([[BOOTSTRAP, 1], [OWN, 1]]),
    );
    // Not the event it claims to be: refused, no credit.
    const forged = { ...note, content: "something else" };
    assertEquals(await ingest.handle(OTHER, forged), "invalid");
    assertEquals(
      (await store.relayScores([alice.pubkey])).get(alice.pubkey)?.has(OTHER),
      false,
    );
  });
});

Deno.test("ingest: the same event from two relays at once records both", async () => {
  await withIngest(async (ingest, store) => {
    const note = sign(alice, 1, { content: "raced" });
    const outcomes = await Promise.all([
      ingest.handle(BOOTSTRAP, note),
      ingest.handle(OWN, note),
    ]);
    assertEquals(outcomes, ["stored", "known"]);
    assertEquals(
      (await store.relayScores([alice.pubkey])).get(alice.pubkey),
      new Map([[BOOTSTRAP, 1], [OWN, 1]]),
    );
  });
});

Deno.test("ingest: an invalid event is not credited to a second relay", async () => {
  await withIngest(async (ingest, store) => {
    const note = sign(alice, 1, { content: "bad" });
    const bad = { ...note, sig: "0".repeat(128) };
    const outcomes = await Promise.all([
      ingest.handle(BOOTSTRAP, bad),
      ingest.handle(OWN, bad),
    ]);
    assertEquals(outcomes, ["invalid", "known"]);
    assertEquals((await store.relayScores([alice.pubkey])).size, 0);
    assertEquals(store.has(note.id), false);
  });
});

Deno.test("planning follows the relay that delivered the author's events, not the first one", async () => {
  await withIngest(async (ingest, store) => {
    // The bootstrap relay is the fast one; the author's own relay is slower.
    for (let i = 0; i < 5; i++) {
      const note = sign(alice, 1, { content: `note ${i}` });
      await ingest.handle(BOOTSTRAP, note);
      await ingest.handle(OWN, note);
    }
    const scores = await store.relayScores([alice.pubkey]);
    const plan = (
      scores: ReadonlyMap<string, ReadonlyMap<string, number>>,
    ) =>
      planRelays({
        authors: new Map([[alice.pubkey, 1]]),
        relayLists: new Map([[alice.pubkey, {
          read: [],
          write: [OTHER, OWN],
        }]]),
        scores,
        bootstrapRelays: [BOOTSTRAP],
        // The bootstrap relay and one more.
        maxRelays: 2,
        excluded: new Set(),
        allowPrivateRelays: false,
      });
    // With first arrivals only, the own relay has no credit and loses the
    // tie to the other one by URL.
    const firstOnly = new Map([[alice.pubkey, new Map([[BOOTSTRAP, 5]])]]);
    assertEquals([...plan(firstOnly).keys()].sort(), [OTHER, BOOTSTRAP].sort());
    // With every relay that delivered, it wins.
    assertEquals([...plan(scores).keys()].sort(), [OWN, BOOTSTRAP].sort());
    assertEquals(plan(scores).get(OWN)?.authors.has(alice.pubkey), true);
  });
});
