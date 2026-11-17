import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import { testConfig } from "../testing/mod.ts";
import { QueryLimitError, type TripleStore } from "../types.ts";
import { openEmbeddedStore } from "./embedded_store.ts";
import { openEventStore, openTripleStore } from "./mod.ts";
import { DAY, identities, sign } from "./test_util.ts";

const [alice] = identities(1);

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "scuttle-store-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const triple = (n: number) => `<urn:s${n}> <urn:p> "v${n}" .\n`;

Deno.test("embedded store: insert, queries of every form, size", async () => {
  await withDir(async (dir) => {
    const store = await openTripleStore(testConfig({ dataDir: dir }));
    try {
      await store.insert(triple(1) + triple(2));
      await store.insert(triple(2));
      await store.insert("");
      assertEquals(await store.size(), 2);
      const rows = await store.select(
        "SELECT ?s WHERE { ?s <urn:p> ?o } ORDER BY ?s",
      );
      assertEquals(rows.map((r) => r.s.value), ["urn:s1", "urn:s2"]);
      assertEquals(await store.ask('ASK { <urn:s1> <urn:p> "v1" }'), true);
      assertEquals(await store.ask('ASK { <urn:s1> <urn:p> "nope" }'), false);
      const select = await store.query(
        "# comment\nPREFIX p: <urn:>\nSELECT * WHERE { ?s p:p ?o }",
      );
      assertEquals(select.contentType, "application/sparql-results+json");
      assertEquals(JSON.parse(select.body).results.bindings.length, 2);
      const construct = await store.query(
        "CONSTRUCT { ?s <urn:q> ?o } WHERE { ?s <urn:p> ?o }",
      );
      assertEquals(construct.contentType, "application/n-triples");
      assertEquals(construct.body.trim().split("\n").length, 2);
      const ask = await store.query("ASK { ?s ?p ?o }");
      assertEquals(JSON.parse(ask.body).boolean, true);
    } finally {
      await store.close();
      await store.close();
    }
  });
});

Deno.test("embedded store: never evaluates updates", async () => {
  await withDir(async (dir) => {
    const store = await openTripleStore(testConfig({ dataDir: dir }));
    try {
      await store.insert(triple(1));
      for (
        const update of [
          "INSERT DATA { <urn:a> <urn:b> <urn:c> }",
          "DELETE WHERE { ?s ?p ?o }",
          "# SELECT\nDROP ALL",
          "PREFIX x: <urn:> CLEAR DEFAULT",
        ]
      ) {
        await assertRejects(
          () => store.query(update),
          Error,
          "Only SPARQL queries",
        );
        await assertRejects(() => store.select(update));
        await assertRejects(() => store.ask(update));
      }
      assertEquals(await store.size(), 1);
    } finally {
      await store.close();
    }
  });
});

Deno.test("embedded store: persistence across close and reopen, appends only", async () => {
  await withDir(async (dir) => {
    const config = testConfig({ dataDir: dir + "/nested/data" });
    let store = await openTripleStore(config);
    await store.insert(triple(1));
    await store.insert(triple(1) + triple(2));
    await store.close();
    const log = await Deno.readTextFile(config.dataDir + "/graph.nt");
    assertEquals(log, triple(1) + triple(1) + triple(2));
    store = await openTripleStore(config);
    assertEquals(await store.size(), 2);
    await store.insert(triple(3));
    await store.close();
    store = await openTripleStore(config);
    assertEquals(await store.size(), 3);
    await store.close();
  });
});

Deno.test("embedded store: a rejected batch is neither loaded nor logged", async () => {
  await withDir(async (dir) => {
    const store = await openTripleStore(testConfig({ dataDir: dir }));
    try {
      await store.insert(triple(1));
      await assertRejects(() =>
        store.insert(triple(2) + "<urn:broken> <urn:p> .\n")
      );
      assertEquals(await store.size(), 1);
      await store.insert(triple(3));
    } finally {
      await store.close();
    }
    assertEquals(
      await Deno.readTextFile(dir + "/graph.nt"),
      triple(1) + triple(3),
    );
  });
});

Deno.test("embedded store: a truncated last line is dropped and the file repaired", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(
      dir + "/graph.nt",
      triple(1) + triple(2) + '<urn:s3> <urn:p> "par',
    );
    let store = await openTripleStore(testConfig({ dataDir: dir }));
    assertEquals(await store.size(), 2);
    await store.insert(triple(4));
    await store.close();
    assertEquals(
      await Deno.readTextFile(dir + "/graph.nt"),
      triple(1) + triple(2) + triple(4),
    );
    store = await openTripleStore(testConfig({ dataDir: dir }));
    assertEquals(await store.size(), 3);
    await store.close();
  });
});

Deno.test("embedded store: a log without any complete line is emptied", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(dir + "/graph.nt", "<urn:s1> <urn:p");
    const store = await openTripleStore(testConfig({ dataDir: dir }));
    assertEquals(await store.size(), 0);
    await store.close();
    assertEquals(await Deno.readTextFile(dir + "/graph.nt"), "");
  });
});

Deno.test("embedded store: multibyte characters survive chunked replay", async () => {
  await withDir(async (dir) => {
    const config = testConfig({ dataDir: dir });
    const store = await openTripleStore(config);
    const value = "🦖".repeat(1000);
    await store.insert(`<urn:s> <urn:p> "${value}" .\n`);
    await store.close();
    const again = await openTripleStore(config);
    const rows = await again.select("SELECT ?o WHERE { ?s ?p ?o }");
    assertEquals(rows[0].o.value, value);
    await again.close();
  });
});

Deno.test("embedded store: a corrupt log is reported", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(dir + "/graph.nt", "this is not n-triples\n");
    await assertRejects(
      () => openTripleStore(testConfig({ dataDir: dir })),
      Error,
      "Corrupt triple log",
    );
  });
});

Deno.test("embedded store: use after close fails", async () => {
  await withDir(async (dir) => {
    const store = await openTripleStore(testConfig({ dataDir: dir }));
    await store.close();
    await assertRejects(() => store.insert(triple(1)), Error, "closed");
    await assertRejects(() => store.size(), Error, "closed");
  });
});

Deno.test("embedded store: concurrent queries and inserts are all answered", async () => {
  await withDir(async (dir) => {
    const store = await openTripleStore(testConfig({ dataDir: dir }));
    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => store.insert(triple(i))),
      );
      const sizes = await Promise.all(
        Array.from({ length: 20 }, () => store.size()),
      );
      assert(sizes.every((n) => n === 20));
    } finally {
      await store.close();
    }
  });
});

Deno.test("event store on the embedded store survives restarts", async () => {
  await withDir(async (dir) => {
    const config = testConfig({ dataDir: dir });
    const now = Math.floor(Date.now() / 1000);
    const events = [
      sign(alice, 1, { content: "a", created_at: now - 40 * DAY }),
      sign(alice, 1, { content: "b", created_at: now - 2 * DAY }),
      sign(alice, 0, { content: "{}", created_at: now - 20 * DAY }),
      sign(alice, 0, { content: '{"name":"x"}', created_at: now - DAY }),
    ];
    let events1 = await openEventStore(await openTripleStore(config), config);
    for (const event of events) {
      await events1.add(event, { seenOn: "wss://r.example.com" });
    }
    const before = await events1.stats();
    await events1.close();

    events1 = await openEventStore(await openTripleStore(config), config);
    try {
      for (const event of events) assert(events1.has(event.id));
      assertEquals(await events1.stats(), before);
      assertEquals((await events1.add(events[0])).status, "duplicate");
      assertEquals(
        (await events1.query([{ kinds: [1] }])).map((e) => e.content),
        ["b", "a"],
      );
      assertEquals(
        (await events1.query([{ kinds: [0] }])).map((e) => e.created_at),
        [
          events[3].created_at,
        ],
      );
      // Windows still work after a restart (earliest date was reloaded).
      assertEquals(
        (await events1.query([{ since: now - 30 * DAY }])).length,
        2,
      );
    } finally {
      await events1.close();
    }
  });
});

Deno.test("event store ignores events cut off in the middle of a batch", async () => {
  await withDir(async (dir) => {
    const config = testConfig({ dataDir: dir });
    const event = sign(alice, 1, { content: "partial" });
    const first = await openEventStore(await openTripleStore(config), config);
    await first.add(event);
    await first.close();
    // Simulate a crash that lost the tail of the batch: the sig line is last.
    const lines = (await Deno.readTextFile(dir + "/graph.nt")).trimEnd().split(
      "\n",
    );
    assert(lines[lines.length - 1].includes("ontology:sig"));
    await Deno.writeTextFile(
      dir + "/graph.nt",
      lines.slice(0, -1).join("\n") + "\n",
    );
    const second = await openEventStore(await openTripleStore(config), config);
    try {
      assertEquals(second.has(event.id), false);
      assertEquals(await second.query([{}]), []);
      assertEquals((await second.add(event)).status, "stored");
      assertEquals((await second.query([{}])).length, 1);
    } finally {
      await second.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Untrusted queries and the replica
// ---------------------------------------------------------------------------

const SHORT = 400;

/** Takes minutes on a few thousand triples, with a result of one row. */
const PATHOLOGICAL =
  "SELECT (COUNT(*) AS ?n) WHERE { ?a ?b ?c . ?d ?e ?f . ?g ?h ?i }";

const SUBJECTS = "SELECT ?s WHERE { ?s <urn:p> ?o } ORDER BY ?s";

const many = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => triple(from + i)).join("");

/** Settles with what `promise` does, so it can be inspected later. */
function settle<T>(promise: Promise<T>) {
  const outcome: { done: boolean; error?: unknown; at?: number } = {
    done: false,
  };
  const finished = promise.then(() => {}, (error) => {
    outcome.error = error;
  }).then(() => {
    outcome.done = true;
    outcome.at = performance.now();
  });
  return { outcome, finished };
}

/** Retries an untrusted query until the replica is back. */
async function untrustedWhenReady(
  store: TripleStore,
  sparql: string,
): Promise<{ contentType: string; body: string }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await store.query(sparql, { untrusted: true });
    } catch (error) {
      if (!(error instanceof QueryLimitError) || error.reason !== "busy") {
        throw error;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("the replica did not come back");
}

const subjects = (body: string): string[] =>
  JSON.parse(body).results.bindings.map((b: { s: { value: string } }) =>
    b.s.value
  );

Deno.test("embedded store: a runaway untrusted query times out and the node stays responsive", async () => {
  await withDir(async (dir) => {
    const store = await openEmbeddedStore(dir, { untrustedTimeoutMs: SHORT });
    try {
      await store.insert(many(0, 3000));
      // Warm up: the replica is built by the first untrusted query.
      const warm = await store.query(SUBJECTS, { untrusted: true });
      assertEquals(subjects(warm.body).length, 3000);

      const slow = settle(store.query(PATHOLOGICAL, { untrusted: true }));
      await new Promise((r) => setTimeout(r, 50));
      const started = performance.now();
      await store.insert(triple(5000));
      const rows = await store.select(SUBJECTS);
      const elapsed = performance.now() - started;
      assertEquals(rows.length, 3001);
      assert(!slow.outcome.done, "the runaway query was still running");
      assert(elapsed < SHORT / 2, `insert and select took ${elapsed} ms`);

      await slow.finished;
      assertInstanceOf(slow.outcome.error, QueryLimitError);
      assertEquals(slow.outcome.error.reason, "timeout");
      // The node did not wait for the query to end.
      assertEquals(await store.size(), 3001);
    } finally {
      await store.close();
    }
  });
});

Deno.test("embedded store: the replica answers like the primary, also after a rebuild", async () => {
  await withDir(async (dir) => {
    const store = await openEmbeddedStore(dir, { untrustedTimeoutMs: SHORT });
    try {
      await store.insert(many(0, 3000));
      await store.insert(triple(10_000));
      const same = async () => {
        const replica = await untrustedWhenReady(store, SUBJECTS);
        assertEquals(
          subjects(replica.body),
          (await store.select(SUBJECTS)).map((r) => r.s.value),
        );
        return subjects(replica.body).length;
      };
      assertEquals(await same(), 3001);

      // Inserts after the replica exists reach it, a query right after the
      // insert sees them, and a rejected batch changes nothing.
      await store.insert(triple(10_001));
      await assertRejects(() => store.insert("not n-triples"));
      assertEquals(await same(), 3002);

      // Kill the replica, and insert while it is being rebuilt.
      const slow = settle(store.query(PATHOLOGICAL, { untrusted: true }));
      await slow.finished;
      assertInstanceOf(slow.outcome.error, QueryLimitError);
      assertEquals(slow.outcome.error.reason, "timeout");
      await store.insert(triple(10_002));
      await store.insert(many(20_000, 20_050));
      await store.insert(triple(10_003));
      assertEquals(await same(), 3002 + 2 + 50);

      // After the rebuild, further inserts still arrive.
      await store.insert(triple(10_004));
      assertEquals(await same(), 3002 + 2 + 50 + 1);
    } finally {
      await store.close();
    }
  });
});

Deno.test("embedded store: while the replica is rebuilt untrusted queries fail fast", async () => {
  await withDir(async (dir) => {
    const store = await openEmbeddedStore(dir, { untrustedTimeoutMs: SHORT });
    try {
      await store.insert(many(0, 3000));
      await store.query(SUBJECTS, { untrusted: true });
      const waiting = settle(store.query(PATHOLOGICAL, { untrusted: true }));
      const queued = settle(store.query(SUBJECTS, { untrusted: true }));
      await waiting.finished;
      await queued.finished;
      assertEquals(
        (waiting.outcome.error as QueryLimitError).reason,
        "timeout",
      );
      // The innocent query that waited behind it is told to try again.
      assertInstanceOf(queued.outcome.error, QueryLimitError);
      assertEquals(queued.outcome.error.reason, "busy");

      const started = performance.now();
      const error = await store.query(SUBJECTS, { untrusted: true }).then(
        () => undefined,
        (e) => e,
      );
      assertInstanceOf(error, QueryLimitError);
      assertEquals(error.reason, "busy");
      assert(error.retryAfter !== undefined && error.retryAfter >= 1);
      assert(performance.now() - started < 50, "did not fail fast");

      // Trusted queries and inserts are not affected.
      assertEquals(await store.size(), 3000);
      await store.insert(triple(9999));
      assertEquals(
        subjects((await untrustedWhenReady(store, SUBJECTS)).body).length,
        3001,
      );
    } finally {
      await store.close();
    }
  });
});

Deno.test("embedded store: only a few untrusted queries wait for the replica", async () => {
  await withDir(async (dir) => {
    const store = await openEmbeddedStore(dir, {
      untrustedTimeoutMs: SHORT,
      maxQueuedQueries: 1,
    });
    try {
      await store.insert(many(0, 3000));
      await store.query(SUBJECTS, { untrusted: true });
      const running = settle(store.query(PATHOLOGICAL, { untrusted: true }));
      const queued = settle(store.query(SUBJECTS, { untrusted: true }));
      const refused = settle(store.query(SUBJECTS, { untrusted: true }));
      await refused.finished;
      assert(refused.outcome.done && !running.outcome.done);
      assertInstanceOf(refused.outcome.error, QueryLimitError);
      assertEquals(refused.outcome.error.reason, "busy");
      await running.finished;
      await queued.finished;
    } finally {
      await store.close();
    }
  });
});

Deno.test("embedded store: the replica is only built for untrusted queries, and closing stops it", async () => {
  await withDir(async (dir) => {
    const store = await openEmbeddedStore(dir, { untrustedTimeoutMs: SHORT });
    await store.insert(many(0, 3000));
    await store.select(SUBJECTS);
    // Close while a query runs and the replica is about to be rebuilt.
    const slow = settle(store.query(PATHOLOGICAL, { untrusted: true }));
    await new Promise((r) => setTimeout(r, 100));
    await store.close();
    await slow.finished;
    assert(slow.outcome.error instanceof Error);
    await assertRejects(
      () => store.query(SUBJECTS, { untrusted: true }),
      Error,
      "closed",
    );
  });
});

Deno.test("embedded store: a log cut between the events and their bookkeeping is repaired at start", async () => {
  const [bob] = identities(1);
  const group = [
    sign(bob, 3, { tags: [["p", alice.pubkey]], created_at: 1_700_000_000 }),
    sign(bob, 3, { tags: [["p", "cd".repeat(32)]], created_at: 1_700_000_100 }),
    sign(bob, 1, { content: "note", created_at: 1_700_000_200 }),
  ];
  await withDir(async (dir) => {
    const cfg = testConfig({ dataDir: dir });
    let events = await openEventStore(await openTripleStore(cfg), cfg);
    await Promise.all(group.map((event) => events.add(event)));
    await events.close();
    const lines = (await Deno.readTextFile(dir + "/graph.nt")).split("\n");
    // All events are complete before the first line of bookkeeping.
    const lastSig = lines.findLastIndex((l) =>
      l.includes("<nostr:ontology:sig>")
    );
    const firstBookkeeping = lines.findIndex((l) =>
      l.includes("<nostr:ontology:supersededBy>")
    );
    assert(firstBookkeeping > lastSig);
    // Cut in the first line of the bookkeeping, as a crash would.
    const log = lines.slice(0, firstBookkeeping).join("\n") + "\n";
    await Deno.writeTextFile(dir + "/graph.nt", log + "<nostr:note1x> <nos");
    events = await openEventStore(await openTripleStore(cfg), cfg);
    // Both lists are complete; the repair superseded the older one.
    assertEquals(
      (await events.follows([bob.pubkey])).get(bob.pubkey),
      ["cd".repeat(32)],
    );
    await events.close();
    const repaired = await Deno.readTextFile(dir + "/graph.nt");
    assert(repaired.startsWith(log));
    assertEquals(repaired.slice(log.length).trim().split("\n").length, 1);
    assert(repaired.includes("supersededBy"));

    // Nothing left to repair: the second start writes nothing.
    events = await openEventStore(await openTripleStore(cfg), cfg);
    await events.close();
    assertEquals(await Deno.readTextFile(dir + "/graph.nt"), repaired);
  });
});

Deno.test("embedded store: a log cut inside a group is harmless, the retry completes it", async () => {
  const [bob] = identities(1);
  const group = [
    sign(bob, 3, { tags: [["p", alice.pubkey]], created_at: 1_700_000_000 }),
    sign(bob, 3, { tags: [["p", "cd".repeat(32)]], created_at: 1_700_000_100 }),
    sign(bob, 1, { content: "note", created_at: 1_700_000_200 }),
  ];
  await withDir(async (dir) => {
    const cfg = testConfig({ dataDir: dir });
    let events = await openEventStore(await openTripleStore(cfg), cfg);
    await Promise.all(group.map((event) => events.add(event)));
    await events.close();
    const lines = (await Deno.readTextFile(dir + "/graph.nt")).split("\n");
    // Cut after the first signature line: the first list is complete, the
    // rest and all the bookkeeping are missing.
    const firstSig = lines.findIndex((l) => l.includes("<nostr:ontology:sig>"));
    await Deno.writeTextFile(
      dir + "/graph.nt",
      lines.slice(0, firstSig + 1).join("\n") + "\n",
    );
    events = await openEventStore(await openTripleStore(cfg), cfg);
    assertEquals(events.has(group[0].id), true);
    assertEquals(events.has(group[1].id), false);
    // The first list is the only one and stays current: nothing is hidden.
    assertEquals(
      (await events.follows([bob.pubkey])).get(bob.pubkey),
      [alice.pubkey],
    );
    for (const event of group) await events.add(event);
    assertEquals(
      (await events.follows([bob.pubkey])).get(bob.pubkey),
      ["cd".repeat(32)],
    );
    await events.close();
  });
});
