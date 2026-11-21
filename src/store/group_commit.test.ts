import { assert, assertEquals, assertRejects } from "@std/assert";
import { MemoryTripleStore } from "../testing/mod.ts";
import type { AddResult, EventStore, NostrEvent } from "../types.ts";
import { createEventStore } from "./event_store.ts";
import { config, CountingStore, DAY, identities, sign } from "./test_util.ts";

const [alice, bob] = identities(2);
const NOW = Math.floor(Date.now() / 1000);

interface Fixture {
  store: EventStore;
  counting: CountingStore;
  memory: MemoryTripleStore;
}

async function withStore(
  fn: (f: Fixture) => Promise<void>,
  group?: { maxEvents?: number; maxBytes?: number },
): Promise<void> {
  const memory = new MemoryTripleStore();
  const counting = new CountingStore(memory);
  const store = await createEventStore(counting, config(), group);
  try {
    await fn({ store, counting, memory });
  } finally {
    await store.close();
  }
}

/** Add all events in one burst: no awaiting between the calls. */
function burst(store: EventStore, events: NostrEvent[]): Promise<AddResult[]> {
  return Promise.all(events.map((e) => store.add(e)));
}

const statuses = (results: AddResult[]) => results.map((r) => r.status);
const ids = (events: NostrEvent[]) => events.map((e) => e.id);

Deno.test("group: a burst is one group, a lone add is a group of one", async () => {
  await withStore(async ({ store, counting }) => {
    await store.add(sign(alice, 1, { content: "lone" }));
    assertEquals(counting.inserts, 1);
    const events = Array.from(
      { length: 10 },
      (_, i) => sign(alice, 1, { content: `n${i}` }),
    );
    await burst(store, events);
    assertEquals(counting.inserts, 2);
  });
});

Deno.test("group: two versions of a replaceable key, either order and id tie-break", async () => {
  for (const newestFirst of [false, true]) {
    await withStore(async ({ store }) => {
      const old = sign(alice, 0, { content: "{}", created_at: NOW - 100 });
      const cur = sign(alice, 0, { content: "{}", created_at: NOW - 10 });
      const results = await burst(store, newestFirst ? [cur, old] : [old, cur]);
      assertEquals(statuses(results), ["stored", "stored"]);
      assertEquals(ids(await store.query([{ kinds: [0] }])), [cur.id]);
    });
  }
  for (const lowFirst of [false, true]) {
    await withStore(async ({ store }) => {
      const a = sign(alice, 3, { content: "a", created_at: NOW - 10 });
      const b = sign(alice, 3, { content: "b", created_at: NOW - 10 });
      const [low, high] = a.id < b.id ? [a, b] : [b, a];
      await burst(store, lowFirst ? [low, high] : [high, low]);
      assertEquals(ids(await store.query([{ kinds: [3] }])), [low.id]);
    });
  }
});

Deno.test("group: chains of three versions in every arrival order", async () => {
  const v = [100, 50, 10].map((age, i) =>
    sign(alice, 30023, {
      content: `v${i}`,
      tags: [["d", "x"]],
      created_at: NOW - age,
    })
  );
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [
    2,
    1,
    0,
  ]];
  for (const order of orders) {
    await withStore(async ({ store, memory }) => {
      await burst(store, order.map((i) => v[i]));
      assertEquals(ids(await store.query([{ kinds: [30023] }])), [v[2].id]);
      // Every version except the newest has exactly one supersededBy.
      const rows = await memory.select(
        "SELECT ?e (COUNT(?n) AS ?c) WHERE { ?e <nostr:ontology:supersededBy> ?n } GROUP BY ?e",
      );
      assertEquals(rows.length, 2);
      assert(rows.every((r) => r.c.value === "1"));
    });
  }
});

Deno.test("group: a deletion and its target in one group, either order", async () => {
  await withStore(async ({ store }) => {
    const note = sign(alice, 1, { content: "x", created_at: NOW - 100 });
    const del = sign(alice, 5, {
      tags: [["e", note.id]],
      created_at: NOW - 50,
    });
    const results = await burst(store, [note, del]);
    assertEquals(statuses(results), ["stored", "stored"]);
    assertEquals(await store.query([{ kinds: [1] }]), []);
    assert(store.has(note.id));
  });
  await withStore(async ({ store }) => {
    const note = sign(alice, 1, { content: "x", created_at: NOW - 100 });
    const del = sign(alice, 5, {
      tags: [["e", note.id]],
      created_at: NOW - 50,
    });
    const results = await burst(store, [del, note]);
    assertEquals(results[0], { status: "stored" });
    assertEquals(results[1].status, "rejected");
    assert((results[1] as { reason: string }).reason.startsWith("deleted:"));
    assertEquals(store.has(note.id), false);
  });
  await withStore(async ({ store }) => {
    const note = sign(alice, 1, { content: "x" });
    const forged = sign(bob, 5, { tags: [["e", note.id]] });
    assertEquals(statuses(await burst(store, [forged, note])), [
      "stored",
      "stored",
    ]);
    assertEquals(ids(await store.query([{ kinds: [1] }])), [note.id]);
  });
});

Deno.test("group: address deletion and addressable versions in one group", async () => {
  const d = [["d", "post"]];
  const address = `30023:${alice.pubkey}:post`;
  const older = sign(alice, 30023, { tags: d, created_at: NOW - 300 });
  const newer = sign(alice, 30023, { tags: d, created_at: NOW - 100 });
  const del = sign(alice, 5, { tags: [["a", address]], created_at: NOW - 200 });
  for (
    const order of [[older, del, newer], [del, older, newer], [
      newer,
      del,
      older,
    ]]
  ) {
    await withStore(async ({ store }) => {
      const results = await burst(store, order);
      const expected = order.map((e) =>
        e === older && order.indexOf(del) < order.indexOf(older)
          ? "rejected"
          : "stored"
      );
      assertEquals(statuses(results), expected);
      // The newer version post-dates the deletion request and survives.
      assertEquals(ids(await store.query([{ kinds: [30023] }])), [newer.id]);
    });
  }
});

Deno.test("group: mixed outcomes, duplicates within a group, per-event results", async () => {
  await withStore(async ({ store }) => {
    const known = sign(alice, 1, { content: "known" });
    await store.add(known);
    const doomed = sign(alice, 1, { content: "doomed", created_at: NOW - 60 });
    const del = sign(alice, 5, {
      tags: [["e", doomed.id]],
      created_at: NOW - 30,
    });
    await store.add(del);
    const fresh = sign(alice, 1, { content: "fresh" });
    const bad = { ...sign(alice, 1, { content: "bad" }), content: "tampered" };
    const results = await burst(store, [
      known,
      fresh,
      doomed,
      fresh,
      bad,
      sign(alice, 20001, { content: "eph" }),
    ]);
    assertEquals(statuses(results), [
      "duplicate",
      "stored",
      "rejected",
      "duplicate",
      "rejected",
      "ephemeral",
    ]);
    assert((results[2] as { reason: string }).reason.startsWith("deleted:"));
    assert((results[4] as { reason: string }).reason.startsWith("invalid:"));
  });
});

Deno.test("group: subscribers hear stored events in arrival order", async () => {
  await withStore(async ({ store }) => {
    const heard: string[] = [];
    store.subscribe((event, info) =>
      heard.push(`${info.stored}:${event.content}`)
    );
    const events = ["a", "b", "c", "d"].map((c, i) =>
      sign(alice, 1, { content: c, created_at: NOW - i })
    );
    const eph = sign(alice, 20001, { content: "eph" });
    const done: string[] = [];
    const adds = [events[0], events[1], eph, events[2], events[1], events[3]]
      .map(
        (e, i) => store.add(e).then(() => done.push(String(i))),
      );
    await Promise.all(adds);
    assertEquals(heard, ["false:eph", "true:a", "true:b", "true:c", "true:d"]);
    assertEquals(done.length, 6);
  });
});

Deno.test("group: a failing insert rejects the whole group and changes nothing", async () => {
  await withStore(async ({ store, counting }) => {
    const events = [1, 2, 3].map((i) => sign(alice, 1, { content: `n${i}` }));
    const heard: string[] = [];
    store.subscribe((e) => heard.push(e.id));
    counting.failNextInsert = new Error("disk full");
    const results = await Promise.allSettled(events.map((e) => store.add(e)));
    for (const r of results) {
      assertEquals(r.status, "rejected");
      assertEquals((r as PromiseRejectedResult).reason.message, "disk full");
    }
    assert(events.every((e) => !store.has(e.id)));
    assertEquals(heard, []);
    assertEquals(await store.query([{}]), []);
    // The next group is not blocked and may store the same events.
    assertEquals(statuses(await burst(store, events)), [
      "stored",
      "stored",
      "stored",
    ]);
    assertEquals(heard.length, 3);
    assertEquals((await store.stats()).events, 3);
  });
});

Deno.test("group: size limits split a burst into several groups", async () => {
  await withStore(async ({ store, counting }) => {
    const events = Array.from(
      { length: 25 },
      (_, i) => sign(alice, 1, { content: `n${i}` }),
    );
    await burst(store, events);
    assertEquals(counting.inserts, 3);
    assertEquals((await store.stats()).events, 25);
  }, { maxEvents: 10 });
  await withStore(async ({ store, counting }) => {
    const big = "x".repeat(5000);
    await burst(
      store,
      Array.from({ length: 6 }, (_, i) => sign(alice, 1, { content: big + i })),
    );
    // Every event alone exceeds the byte budget, yet each is still committed.
    assertEquals(counting.inserts, 6);
  }, { maxBytes: 1000 });
});

Deno.test("group: close waits for the queue, then adds are refused", async () => {
  await withStore(async ({ store }) => {
    const pending = burst(store, [
      sign(alice, 1),
      sign(alice, 1, { content: "b" }),
    ]);
    const closing = store.close();
    assertEquals(statuses(await pending), ["stored", "stored"]);
    await closing;
    await assertRejects(
      () => store.add(sign(alice, 1, { content: "late" })),
      Error,
      "closed",
    );
  });
});

Deno.test("group: 200 events in one burst need far fewer queries than one by one", async () => {
  const events = Array.from(
    { length: 200 },
    (_, i) =>
      sign(identities(1)[0], i % 10 === 0 ? 0 : 1, {
        content: `n${i}`,
        created_at: NOW - i,
      }),
  );
  let grouped = 0;
  await withStore(async ({ store, counting }) => {
    assertEquals(
      statuses(await burst(store, events)).filter((s) => s === "stored").length,
      200,
    );
    grouped = counting.calls;
    assertEquals(counting.inserts, 1);
  });
  let sequential = 0;
  await withStore(async ({ store, counting }) => {
    for (const event of events) await store.add(event);
    sequential = counting.calls;
  });
  assert(grouped * 20 < sequential, `${grouped} vs ${sequential}`);
});

/** Deterministic shuffle. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

Deno.test("group: a burst equals adding one by one, for random arrival orders", async () => {
  const d = (v: string) => [["d", v]];
  const n1 = sign(alice, 1, { content: "n1", created_at: NOW - 900 });
  const n2 = sign(bob, 1, { content: "n2", created_at: NOW - 800 });
  const sameTime = [
    sign(alice, 3, { content: "a", created_at: NOW - 500 }),
    sign(alice, 3, { content: "b", created_at: NOW - 500 }),
  ];
  const events: NostrEvent[] = [
    n1,
    n2,
    sign(alice, 0, { content: "{}", created_at: NOW - 700 }),
    sign(alice, 0, { content: '{"name":"x"}', created_at: NOW - 600 }),
    ...sameTime,
    sign(alice, 30023, { tags: d("p"), created_at: NOW - 400 }),
    sign(alice, 30023, { tags: d("p"), created_at: NOW - 300 }),
    sign(alice, 30023, { tags: d("p"), created_at: NOW - 100 }),
    sign(alice, 30023, { tags: d("q"), created_at: NOW - 350 }),
    sign(alice, 5, {
      tags: [["e", n1.id], ["e", n2.id]],
      created_at: NOW - 250,
    }),
    sign(alice, 5, {
      tags: [["a", `30023:${alice.pubkey}:p`], ["a", `0:${alice.pubkey}:`]],
      created_at: NOW - 200,
    }),
    sign(bob, 5, { tags: [["e", n1.id]], created_at: NOW - 150 }),
    sign(bob, 7, { content: "+", tags: [["e", n1.id]], created_at: NOW - 140 }),
  ];
  events.push(events[3], n1);

  const run = async (order: NostrEvent[], grouped: boolean) => {
    const memory = new MemoryTripleStore();
    const store = await createEventStore(memory, config());
    const results = grouped ? await burst(store, order) : await (async () => {
      const out: AddResult[] = [];
      for (const e of order) out.push(await store.add(e));
      return out;
    })();
    const graph = (await memory.select("SELECT ?s ?p ?o WHERE { ?s ?p ?o }"))
      .map((r) => `${r.s.value} ${r.p.value} ${r.o.value}`).sort();
    const visible = ids(await store.query([{}]));
    await store.close();
    return { results: results.map((r) => JSON.stringify(r)), graph, visible };
  };
  for (let seed = 1; seed <= 25; seed++) {
    const order = shuffled(events, seed);
    const sequential = await run(order, false);
    const together = await run(order, true);
    assertEquals(together.results, sequential.results, `seed ${seed}`);
    assertEquals(together.visible, sequential.visible, `seed ${seed}`);
    assertEquals(together.graph, sequential.graph, `seed ${seed}`);
  }
});

Deno.test("group: windows still work after grouped adds across many days", async () => {
  await withStore(async ({ store }) => {
    const events = [0, 3, 40, 200].map((days) =>
      sign(alice, 1, { content: `d${days}`, created_at: NOW - days * DAY })
    );
    await burst(store, events);
    assertEquals(
      (await store.query([{ kinds: [1], limit: 3 }])).map((e) => e.content),
      ["d0", "d3", "d40"],
    );
  });
});
