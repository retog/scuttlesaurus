import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { testConfig } from "../testing/mod.ts";
import type { EventStore } from "../types.ts";
import { createEventStore } from "./event_store.ts";
import { defineEventStoreTests } from "./event_store_suite.ts";
import { eventToTriples } from "./event_triples.ts";
import { type FakeQleverDir, startFakeQleverDir } from "./fake_qlever_dir.ts";
import {
  openQleverDirStore,
  type QleverDirOptions,
  type QleverDirStore,
} from "./qlever_dir_store.ts";
import { assertPlausibleNTriples, dayPath, graphIri } from "./qlever_graph.ts";
import { CountingStore, identities, sign } from "./test_util.ts";

const BASE = "https://scuttlesaurus.test/graph/";
const triple = (n: number) => `<urn:s${n}> <urn:p> "v${n}" .\n`;

interface Fixture {
  dir: string;
  graphDir: string;
  fake: FakeQleverDir;
  open(options?: QleverDirOptions): Promise<QleverDirStore>;
  /** The relative paths of all `.nt` files under the graph directory. */
  files(): Promise<string[]>;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string) => {
    try {
      for await (const entry of Deno.readDir(current)) {
        const path = join(current, entry.name);
        if (entry.isDirectory) await walk(path);
        else out.push(path.slice(dir.length + 1));
      }
    } catch (error) {
      // A consolidation running beside the test may remove a day directory
      // between listing its parent and reading it: then it holds no files.
      if (!(error instanceof Deno.errors.NotFound) || current === dir) {
        throw error;
      }
    }
  };
  await walk(dir);
  return out.sort();
}

/** A fake qlever-dir on a temporary directory; everything is cleaned up. */
async function withFixture(
  fn: (f: Fixture) => Promise<void>,
  delayMs = 0,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "scuttle-qdir-" });
  const graphDir = join(dir, "graph");
  await Deno.mkdir(graphDir);
  const fake = startFakeQleverDir({ dir: graphDir, baseUri: BASE, delayMs });
  const opened: QleverDirStore[] = [];
  try {
    await fn({
      dir,
      graphDir,
      fake,
      async open(options = {}) {
        const store = await openQleverDirStore(
          { kind: "qlever-dir", queryUrl: fake.url, graphDir, baseUri: BASE },
          {
            pollStartMs: 5,
            pollMaxMs: 20,
            consolidateOnOpen: false,
            consolidateEveryMs: 0,
            log: () => {},
            ...options,
          },
        );
        opened.push(store);
        return store;
      },
      files: () => listFiles(graphDir),
    });
  } finally {
    for (const store of opened) await store.close();
    await fake.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const all = async (store: QleverDirStore) =>
  (await store.select("SELECT ?s ?p ?o WHERE { ?s ?p ?o }"))
    .map((r) => `${r.s.value} ${r.p.value} ${r.o.value}`).sort();

Deno.test("qlever-dir: insert writes a named file and resolves when visible", async () => {
  await withFixture(async (f) => {
    const clock = new Date(Date.UTC(2026, 10, 13, 12, 30));
    const store = await f.open({ now: () => clock });
    await store.insert(triple(1) + triple(2));
    const files = await f.files();
    assertEquals(files.length, 1);
    assertEquals(
      files[0],
      `2026/11/13/${clock.getTime()}-000000.nt`,
    );
    assertEquals(
      await Deno.readTextFile(join(f.graphDir, files[0])),
      triple(1) + triple(2),
    );
    assertEquals(f.fake.graphs(), [BASE + files[0]]);
    assertEquals(await store.size(), 2);
    await store.insert(triple(2).trimEnd() + "\n" + triple(3));
    assertEquals((await f.files()).length, 2);
    assertEquals((await f.files())[1].endsWith("-000001.nt"), true);
    assertEquals(await store.size(), 3);
    assertEquals(await store.ask('ASK { <urn:s1> <urn:p> "v1" }'), true);
    await store.insert("");
    assertEquals((await f.files()).length, 2);
    // No temporary files are left behind.
    assert((await f.files()).every((name) => name.endsWith(".nt")));
  });
});

Deno.test("qlever-dir: insert does not resolve before the graph is visible", async () => {
  await withFixture(async (f) => {
    const store = await f.open();
    const started = performance.now();
    let settled = false;
    const done = store.insert(triple(1)).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 150));
    assertEquals(settled, false);
    await done;
    assert(performance.now() - started >= 300);
    assertEquals(await store.size(), 1);
  }, 300);
});

Deno.test("qlever-dir: a timeout names the file and keeps it", async () => {
  await withFixture(async (f) => {
    const store = await f.open({ visibleTimeoutMs: 150 });
    const error = await assertRejects(() => store.insert(triple(1)), Error);
    const [file] = await f.files();
    assert(error.message.includes(file), error.message);
    assert(error.message.includes("did not show"), error.message);
    assert(error.message.includes(graphIri(BASE, file)), error.message);
  }, 60_000);
});

Deno.test("qlever-dir: a malformed line is rejected and nothing is written", async () => {
  await withFixture(async (f) => {
    const store = await f.open();
    for (
      const bad of [
        triple(1) + "<urn:s> <urn:p> .\n",
        '<urn:s> <urn:p> "unterminated .\n',
        "<urn:s> <urn:p> <urn:o>\n",
        "not a triple\n",
        '"lit" <urn:p> <urn:o> .\n',
        "<urn:s> <urn:p> <urn:o> . extra\n",
      ]
    ) {
      await assertRejects(() => store.insert(bad), Error, "N-Triples");
    }
    assertEquals(await f.files(), []);
    assertEquals(await store.size(), 0);
  });
});

Deno.test("qlever-dir: a file qlever-dir cannot parse is reported, not hidden", async () => {
  await withFixture(async (f) => {
    const store = await f.open();
    // Passes the cheap check but is not a legal IRI for the real parser.
    await assertRejects(
      () => store.insert('<urn:s> <urn:p> "x"^^<http://a/%zz> .\n'),
      Error,
      "could not parse",
    );
  });
});

Deno.test("qlever-dir: transient endpoint errors while polling are retried", async () => {
  await withFixture(async (f) => {
    const store = await f.open();
    f.fake.failNext(6, 502);
    await store.insert(triple(1));
    assertEquals(await store.size(), 1);
  });
});

Deno.test("qlever-dir: queries ride out a brief 502 but not a bad query", async () => {
  await withFixture(async (f) => {
    const store = await f.open();
    await store.insert(triple(1));
    f.fake.failNext(3, 502);
    assertEquals(await store.size(), 1);
    f.fake.failNext(2, 503);
    assertEquals(await store.ask("ASK { ?s ?p ?o }"), true);
    const requests = f.fake.requests;
    await assertRejects(() => store.select("SELECT nonsense"), Error, "400");
    assertEquals(f.fake.requests, requests + 1);
  });
});

Deno.test("qlever-dir: opening waits for a late endpoint and logs once", async () => {
  await withFixture(async (f) => {
    f.fake.pause();
    const logs: string[] = [];
    const opening = f.open({ openRetryMs: 20, log: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 150));
    f.fake.resume();
    const store = await opening;
    assertEquals(logs.length, 1);
    assert(logs[0].includes(f.fake.url));
    await store.insert(triple(1));
  });
});

Deno.test("qlever-dir: opening gives up with an error naming the URL", async () => {
  await withFixture(async (f) => {
    f.fake.pause();
    const error = await assertRejects(
      () => f.open({ openTimeoutMs: 100, openRetryMs: 20 }),
      Error,
    );
    assert(error.message.includes(f.fake.url), error.message);
  });
});

Deno.test("qlever-dir: opening creates the graph directory", async () => {
  await withFixture(async (f) => {
    const nested = join(f.dir, "a", "b");
    const store = await openQleverDirStore(
      {
        kind: "qlever-dir",
        queryUrl: f.fake.url,
        graphDir: nested,
        baseUri: BASE,
      },
      { consolidateOnOpen: false, consolidateEveryMs: 0 },
    );
    assert((await Deno.stat(nested)).isDirectory);
    await store.close();
  });
});

/** Write batches on given days; returns the clock-controlled store. */
async function seedDays(
  f: Fixture,
  days: Record<string, number>,
): Promise<QleverDirStore> {
  let clock = new Date();
  const store = await f.open({ now: () => clock });
  let n = 0;
  for (const [day, batches] of Object.entries(days)) {
    for (let i = 0; i < batches; i++) {
      clock = new Date(`${day}T12:00:00Z`);
      await store.insert(triple(n++) + triple(1000));
    }
  }
  return store;
}

Deno.test("qlever-dir: consolidation merges old days and leaves recent ones", async () => {
  await withFixture(async (f) => {
    const store = await seedDays(f, {
      "2026-10-30": 1,
      "2026-11-01": 3,
      "2026-11-12": 2,
      "2026-11-13": 2,
    });
    const before = await all(store);
    const mtime = async () =>
      (await Deno.stat(join(f.graphDir, "2026/11/01.nt"))).mtime!.getTime();

    await store.consolidate(new Date("2026-11-13T10:00:00Z"));
    const files = await f.files();
    assert(files.includes("2026/11/01.nt"));
    assertEquals(files.filter((x) => x.startsWith("2026/11/01/")), []);
    assertEquals(files.filter((x) => x.startsWith("2026/11/12/")).length, 2);
    assertEquals(files.filter((x) => x.startsWith("2026/11/13/")).length, 2);
    assertEquals(files.filter((x) => x.startsWith("2026/10/30/")).length, 1);
    assertEquals(await all(store), before);
    assertEquals(f.fake.graphs().length, 1 + 2 + 2 + 1);
    const merged = await Deno.readTextFile(join(f.graphDir, "2026/11/01.nt"));
    assertEquals(merged.split("\n").filter(Boolean).length, 4);

    // Idempotent: nothing to do the second time.
    const stamp = await mtime();
    await store.consolidate(new Date("2026-11-13T10:00:00Z"));
    assertEquals(await mtime(), stamp);
    assertEquals(await f.files(), files);

    // A day later, yesterday's directory is old enough.
    await store.consolidate(new Date("2026-11-14T00:00:01Z"));
    assert((await f.files()).includes("2026/11/12.nt"));
    assertEquals(
      (await f.files()).some((x) => x.startsWith("2026/11/12/")),
      false,
    );
    assertEquals(await all(store), before);
  });
});

Deno.test("qlever-dir: a crash between merge and removal is finished by the next run", async () => {
  await withFixture(async (f) => {
    const store = await seedDays(f, { "2026-11-01": 3 });
    const before = await all(store);
    // What an interrupted run leaves: the merged file next to the directory.
    const dayDir = join(f.graphDir, "2026/11/01");
    const lines = new Set<string>();
    for (const name of (await listFiles(dayDir)).sort()) {
      for (
        const line of (await Deno.readTextFile(join(dayDir, name))).split("\n")
      ) {
        if (line) lines.add(line);
      }
    }
    await Deno.writeTextFile(
      join(f.graphDir, "2026/11/01.nt"),
      [...lines].join("\n") + "\n",
    );
    assertEquals(await all(store), before);
    await store.consolidate(new Date("2026-11-13T00:00:00Z"));
    assertEquals(await f.files(), ["2026/11/01.nt"]);
    assertEquals(await all(store), before);
  });
});

Deno.test("qlever-dir: consolidation folds leftovers into an existing merged file", async () => {
  await withFixture(async (f) => {
    const store = await seedDays(f, { "2026-11-01": 3 });
    const before = await all(store);
    const dayDir = join(f.graphDir, "2026/11/01");
    const [first] = (await listFiles(dayDir)).sort();
    // A stale merged file that holds only the first batch.
    await Deno.writeTextFile(
      join(f.graphDir, "2026/11/01.nt"),
      await Deno.readTextFile(join(dayDir, first)),
    );
    f.fake.setDelay(80);
    await store.consolidate(new Date("2026-11-13T00:00:00Z"));
    assertEquals(await f.files(), ["2026/11/01.nt"]);
    assertEquals(await all(store), before);
  });
});

Deno.test("qlever-dir: concurrent consolidations do not overlap", async () => {
  await withFixture(async (f) => {
    const store = await seedDays(f, { "2026-11-01": 3, "2026-11-02": 3 });
    const before = await all(store);
    const now = new Date("2026-11-13T00:00:00Z");
    await Promise.all([
      store.consolidate(now),
      store.consolidate(now),
      store.consolidate(now),
    ]);
    assertEquals(await f.files(), ["2026/11/01.nt", "2026/11/02.nt"]);
    assertEquals(await all(store), before);
  });
});

Deno.test("qlever-dir: consolidation runs on a timer and at open; the timer stops at close", async () => {
  await withFixture(async (f) => {
    await seedDays(f, { "2026-11-01": 2 });
    const store = await f.open({
      consolidateOnOpen: true,
      now: () => new Date("2026-11-13T00:00:00Z"),
    });
    for (let i = 0; i < 100 && (await f.files()).length > 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(await f.files(), ["2026/11/01.nt"]);
    await store.close();
  });
  await withFixture(async (f) => {
    await seedDays(f, { "2026-11-02": 2 });
    const store = await f.open({
      consolidateEveryMs: 30,
      now: () => new Date("2026-11-13T00:00:00Z"),
    });
    for (let i = 0; i < 100 && (await f.files()).length > 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(await f.files(), ["2026/11/02.nt"]);
    await store.close();
  });
});

Deno.test("qlever-dir: consolidation errors are logged and lose nothing", async () => {
  await withFixture(async (f) => {
    await seedDays(f, { "2026-11-01": 2 });
    f.fake.setDelay(60_000);
    const logs: string[] = [];
    const store = await f.open({
      consolidateOnOpen: true,
      visibleTimeoutMs: 100,
      log: (m) => logs.push(m),
      now: () => new Date("2026-11-13T00:00:00Z"),
    });
    for (
      let i = 0;
      i < 100 && !logs.some((m) => m.includes("consolidation failed"));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(logs.some((m) => m.includes("consolidation failed")), String(logs));
    // The merged file was never shown, so the batch files must still be there.
    assertEquals((await f.files()).filter((x) => x.includes("/01/")).length, 2);
    await assertRejects(() =>
      store.consolidate(new Date("2026-11-13T00:00:00Z"))
    );
  });
});

/** N-Triples of `count` signed notes, as a migrated embedded graph would hold. */
function migratedGraph(count: number) {
  const [alice] = identities(1);
  const events = Array.from(
    { length: count },
    (_, i) => sign(alice, 1, { content: `migrated ${i}` }),
  );
  return { events, ntriples: events.map((e) => eventToTriples(e)).join("") };
}

Deno.test("qlever-dir: opening waits until files already in the directory are visible", async () => {
  await withFixture(async (f) => {
    const { events, ntriples } = migratedGraph(20);
    await Deno.writeTextFile(join(f.graphDir, "embedded.nt"), ntriples);
    await Deno.mkdir(join(f.graphDir, "a/b"), { recursive: true });
    await Deno.writeTextFile(join(f.graphDir, "a/b/my file.nt"), triple(1));
    await Deno.writeTextFile(join(f.graphDir, "a/empty.nt"), "");
    await Deno.writeTextFile(join(f.graphDir, "half.nt.tmp"), "<urn:x");
    const logs: string[] = [];
    const started = performance.now();
    const triples = await f.open({ log: (m) => logs.push(m) });
    assert(performance.now() - started >= 300);
    // The fake also loads the empty file, which the store does not wait for.
    assertEquals(f.fake.graphs().length, 3);
    assert(
      logs.some((m) => m.includes("waiting") && m.includes("2 of 2")),
      String(logs),
    );
    assert(logs.some((m) => m.includes("all 2 checked files")), String(logs));
    const store = await createEventStore(triples, testConfig());
    for (const event of events) assert(store.has(event.id));
  }, 300);
});

/** Deno reports inode change times with a resolution of one second. */
const pause = () => new Promise<void>((r) => setTimeout(r, 1100));

/** Options that persist `confirmedAt` in the fixture, without a margin. */
const withState = (
  f: Fixture,
  extra: QleverDirOptions = {},
): QleverDirOptions => ({
  stateFile: join(f.dir, "state.json"),
  safetyMarginMs: 0,
  ...extra,
});

const readConfirmed = async (f: Fixture): Promise<number> =>
  JSON.parse(await Deno.readTextFile(join(f.dir, "state.json"))).confirmedAt;

Deno.test("qlever-dir: a reopen after a clean close sends no visibility query", async () => {
  await withFixture(async (f) => {
    const first = await f.open(withState(f));
    await first.insert(triple(1));
    await first.insert(triple(2));
    await first.close();
    const requests = f.fake.requests;
    const logs: string[] = [];
    const second = await f.open(withState(f, { log: (m) => logs.push(m) }));
    // Only the `ASK {}` that checks the endpoint is up.
    assertEquals(f.fake.requests - requests, 1);
    assertEquals(logs, []);
    assertEquals(await second.size(), 2);
  });
});

Deno.test("qlever-dir: only files newer than confirmedAt are asked about", async () => {
  await withFixture(async (f) => {
    const first = await f.open(withState(f));
    await first.insert(triple(1));
    await first.close();
    await pause();
    await Deno.writeTextFile(join(f.graphDir, "new.nt"), triple(7));
    const requests = f.fake.requests;
    const logs: string[] = [];
    await f.open(withState(f, { log: (m) => logs.push(m) }));
    // ASK {}, one name query for 1 candidate, one parse-error query.
    assertEquals(f.fake.requests - requests, 3);
    assert(logs.some((m) => m.includes("all 1 checked files")), String(logs));
  });
});

Deno.test("qlever-dir: a file copied in while down is checked despite an old mtime", async () => {
  await withFixture(async (f) => {
    const first = await f.open(withState(f));
    await first.insert(triple(1));
    await first.close();
    await pause();
    const { events, ntriples } = migratedGraph(10);
    const copied = join(f.graphDir, "embedded.nt");
    await Deno.writeTextFile(copied, ntriples);
    const old = new Date("2020-01-01T00:00:00Z");
    await Deno.utime(copied, old, old);
    f.fake.setDelay(250);
    const started = performance.now();
    const second = await f.open(withState(f));
    assert(performance.now() - started >= 250);
    const store = await createEventStore(second, testConfig());
    for (const event of events) assert(store.has(event.id));
  });
});

Deno.test("qlever-dir: a file whose insert timed out is checked at the next open", async () => {
  await withFixture(async (f) => {
    const first = await f.open(
      withState(f, { visibleTimeoutMs: 100, safetyMarginMs: 5000 }),
    );
    await first.insert(triple(1));
    f.fake.setDelay(60_000);
    await assertRejects(() => first.insert(triple(2)), Error, "did not show");
    // Later successes cannot advance confirmedAt past the unconfirmed file.
    f.fake.setDelay(0);
    await first.insert(triple(3));
    await first.close();
    const [, timedOut] = await f.files();
    const written = (await Deno.stat(join(f.graphDir, timedOut))).mtime!;
    // The kernel stamps files with a coarser clock than Date.now(), so the
    // file may appear a few milliseconds older than it is; the safety margin
    // is there for that.
    assert(await readConfirmed(f) < written.getTime() + 50);
    const logs: string[] = [];
    const second = await f.open(
      withState(f, { safetyMarginMs: 5000, log: (m) => logs.push(m) }),
    );
    assert(logs.some((m) => m.includes("checked files")), String(logs));
    assertEquals(await second.size(), 3);
  });
});

Deno.test("qlever-dir: a missing, corrupt or foreign state file means check everything", async () => {
  const damages: [string, (state: string) => Promise<void>][] = [
    ["missing", (state) => Deno.remove(state)],
    ["corrupt", (state) => Deno.writeTextFile(state, "{not json")],
    [
      "wrong version",
      (state) =>
        Deno.writeTextFile(
          state,
          JSON.stringify({ version: 99, confirmedAt: Date.now() }),
        ),
    ],
    [
      "another graph directory",
      (state) =>
        Deno.writeTextFile(
          state,
          JSON.stringify({
            version: 1,
            graphDir: "/elsewhere",
            baseUri: BASE,
            confirmedAt: Date.now() + 1000,
          }),
        ),
    ],
  ];
  for (const [name, damage] of damages) {
    await withFixture(async (f) => {
      const first = await f.open(withState(f));
      await first.insert(triple(1));
      await first.close();
      await damage(join(f.dir, "state.json"));
      const requests = f.fake.requests;
      const second = await f.open(withState(f));
      assert(f.fake.requests - requests > 1, name);
      await second.close();
      // The state is rewritten and trusted again.
      const third = requests;
      const before = f.fake.requests;
      await f.open(withState(f));
      assertEquals(f.fake.requests - before, 1, name + String(third));
    });
  }
});

Deno.test("qlever-dir: confirmedAt only moves forward and is flushed on close", async () => {
  await withFixture(async (f) => {
    const store = await f.open(
      withState(f, { stateWriteIntervalMs: 3_600_000 }),
    );
    const atOpen = await readConfirmed(f);
    await store.insert(triple(1));
    await store.insert(triple(2));
    // Debounced: the file still holds the value from open.
    assertEquals(await readConfirmed(f), atOpen);
    await store.close();
    const flushed = await readConfirmed(f);
    assert(flushed > atOpen);
    const files = await f.files();
    const newest = (await Deno.stat(join(f.graphDir, files[files.length - 1])))
      .ctime!;
    assert(flushed >= newest.getTime());
    const again = await f.open(withState(f));
    await again.close();
    assert((await readConfirmed(f)) >= flushed);
  });
});

Deno.test("qlever-dir: many candidates are asked about in chunks", async () => {
  await withFixture(async (f) => {
    for (let i = 0; i < 650; i++) {
      await Deno.writeTextFile(join(f.graphDir, `f${i}.nt`), triple(i));
    }
    const requests = f.fake.requests;
    await f.open(withState(f));
    // ASK {}, 3 chunks of names, 3 chunks of parse-error checks.
    assertEquals(f.fake.requests - requests, 7);
  });
});

Deno.test("qlever-dir: opening with no pending files does not wait or log", async () => {
  await withFixture(async (f) => {
    const logs: string[] = [];
    await f.open({ log: (m) => logs.push(m) });
    assertEquals(logs, []);
  });
});

Deno.test("qlever-dir: opening gives up on a file that never becomes visible", async () => {
  await withFixture(async (f) => {
    await Deno.writeTextFile(join(f.graphDir, "embedded.nt"), triple(1));
    const error = await assertRejects(
      () => f.open({ openTimeoutMs: 200 }),
      Error,
    );
    assert(error.message.includes("embedded.nt"), error.message);
    assert(error.message.includes(BASE), error.message);
    assert(error.message.includes("1 of 1"), error.message);
  }, 60_000);
});

Deno.test("qlever-dir: a copied file qlever-dir rejects is visible but logged as a warning", async () => {
  await withFixture(async (f) => {
    await Deno.writeTextFile(
      join(f.graphDir, "bad.nt"),
      "this is not n-triples\n",
    );
    await Deno.writeTextFile(join(f.graphDir, "good.nt"), triple(1));
    const logs: string[] = [];
    await f.open({ log: (m) => logs.push(m) });
    const warnings = logs.filter((m) => m.includes("WARNING"));
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes("bad.nt"));
  });
});

Deno.test("qlever-dir: consolidation never touches files it does not own", async () => {
  await withFixture(async (f) => {
    await Deno.writeTextFile(join(f.graphDir, "embedded.nt"), triple(500));
    await Deno.writeTextFile(join(f.graphDir, "2026-notes.nt"), triple(501));
    await Deno.mkdir(join(f.graphDir, "2026/11/02"), { recursive: true });
    await Deno.writeTextFile(
      join(f.graphDir, "2026/11/02/foreign.nt"),
      triple(502),
    );
    await Deno.writeTextFile(
      join(f.graphDir, "2026/11/02/1-000000.nt"),
      triple(503),
    );
    await Deno.writeTextFile(
      join(f.graphDir, "2026/11/02/2-000000.nt"),
      triple(504),
    );
    await Deno.writeTextFile(join(f.graphDir, "2026/11/03.nt"), triple(505));
    const logs: string[] = [];
    const store = await f.open({ log: (m) => logs.push(m) });
    const seeded = await seedDays(f, { "2026-11-01": 2 });
    const before = await all(seeded);
    const files = await f.files();
    await store.consolidate(new Date("2026-11-13T00:00:00Z"));
    const after = await f.files();
    // Only the day directory made of our own batch files was merged.
    assertEquals(
      after.filter((x) => !x.startsWith("2026/11/01")),
      files.filter((x) => !x.startsWith("2026/11/01")),
    );
    assert(after.includes("2026/11/01.nt"));
    assertEquals(after.some((x) => x.startsWith("2026/11/01/")), false);
    assert(logs.some((m) => m.includes("not consolidating")));
    assertEquals(await all(store), before);
  });
});

Deno.test("qlever-dir: the insert timeout says what is most likely wrong", async () => {
  await withFixture(async (f) => {
    const store = await f.open({ visibleTimeoutMs: 100 });
    const error = await assertRejects(() => store.insert(triple(1)), Error);
    assert(error.message.includes("QLEVER_DIR_BASE_URI"), error.message);
    assert(error.message.includes(BASE), error.message);
    assert(error.message.includes("BASE_URI plus"), error.message);
    assert(error.message.includes("is kept in"), error.message);
  }, 60_000);
});

Deno.test("qlever-dir: graph IRIs are built as qlever-dir builds them", () => {
  assertEquals(
    graphIri(BASE, "2026/11/13/1-000000.nt"),
    BASE + "2026/11/13/1-000000.nt",
  );
  assertThrows(() => graphIri(BASE, "a b.nt"), Error, "escaping");
  assertThrows(() => graphIri(BASE, 'a"b.nt'), Error, "escaping");
  assertEquals(dayPath(new Date("2026-01-05T23:59:59Z")), "2026/01/05");
});

Deno.test("qlever-dir: everything the event mapping emits passes the line check", () => {
  const [alice] = identities(1);
  const evil = [
    '"> . <urn:x> <urn:y> "',
    "\u0000\u001f\u007f",
    '<>"{}|^`\\',
    "a b",
    "\n🦖 ",
  ];
  for (const value of evil) {
    for (const kind of [0, 1, 3, 5, 7, 1111, 10002, 10063, 30023]) {
      const tags = ["e", "p", "a", "r", "server", "image", "title", "d", "t"]
        .map((n) => [n, value]);
      const event = sign(alice, kind, {
        content: kind === 0
          ? JSON.stringify({ name: value, picture: value })
          : value,
        tags,
      });
      assertPlausibleNTriples(
        eventToTriples(event, { seenOn: "wss://r.example.com" }),
      );
    }
  }
});

Deno.test("qlever-dir: a burst of events is one file", async () => {
  await withFixture(async (f) => {
    const triples = await f.open();
    const counting = new CountingStore(triples);
    const config = testConfig();
    const events = await createEventStore(counting, config);
    const [alice] = identities(1);
    const results = await Promise.all(
      Array.from(
        { length: 50 },
        (_, i) => events.add(sign(alice, 1, { content: `n${i}` })),
      ),
    );
    assert(results.every((r) => r.status === "stored"));
    assertEquals((await f.files()).length, 1);
    assertEquals(counting.inserts, 1);
    // A restart reads the ids back through SPARQL.
    const again = await createEventStore(await f.open(), config);
    assertEquals((await again.stats()).events, 50);
  }, 30);
});

let counter = 0;
defineEventStoreTests("qlever-dir (fake)", async (overrides) => {
  const dir = await Deno.makeTempDir({ prefix: "scuttle-qdir-suite-" });
  const graphDir = join(dir, "graph");
  await Deno.mkdir(graphDir);
  const fake = startFakeQleverDir({
    dir: graphDir,
    baseUri: BASE,
    delayMs: counter++ % 2 * 15,
  });
  let store: EventStore | undefined;
  try {
    const triples = await openQleverDirStore(
      { kind: "qlever-dir", queryUrl: fake.url, graphDir, baseUri: BASE },
      {
        pollStartMs: 5,
        pollMaxMs: 20,
        consolidateOnOpen: false,
        consolidateEveryMs: 0,
        log: () => {},
      },
    );
    store = await createEventStore(triples, testConfig(overrides));
  } catch (error) {
    await fake.close();
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
  return {
    store,
    cleanup: async () => {
      await fake.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
});
