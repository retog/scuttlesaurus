import { assert, assertEquals, assertRejects } from "@std/assert";
import { testConfig } from "../testing/mod.ts";
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
