/**
 * Live test against a running qlever-dir. Skipped unless these are set:
 * `QLEVER_DIR_TEST_URL` (the endpoint), `QLEVER_DIR_TEST_DIR` (the watched
 * directory, as seen from this machine) and optionally
 * `QLEVER_DIR_TEST_BASE_URI` (qlever-dir's `BASE_URI`, default
 * `https://example.org/data/`).
 */
import { assert, assertEquals } from "@std/assert";
import { verifyEvent } from "@nostr/tools/pure";
import { join } from "@std/path";
import { testConfig } from "../testing/mod.ts";
import type { NostrEvent } from "../types.ts";
import { createEventStore } from "./event_store.ts";
import { eventToTriples } from "./event_triples.ts";
import { SparqlClient } from "./sparql_client.ts";
import { openQleverDirStore } from "./qlever_dir_store.ts";
import { DAY, identities, sign } from "./test_util.ts";

const url = Deno.env.get("QLEVER_DIR_TEST_URL");
const dir = Deno.env.get("QLEVER_DIR_TEST_DIR");
const base = Deno.env.get("QLEVER_DIR_TEST_BASE_URI") ??
  "https://example.org/data/";

async function listTree(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) out.push(...await listTree(root, path));
    else out.push(path);
  }
  return out.sort();
}

Deno.test({
  name: "qlever-dir live: the event store on a real qlever-dir",
  ignore: !url || !dir,
  fn: async () => {
    const run = `it-${crypto.randomUUID().slice(0, 8)}`;
    const graphDir = join(dir!, run);
    const triples = await openQleverDirStore(
      {
        kind: "qlever-dir",
        queryUrl: url!,
        graphDir,
        baseUri: `${base}${run}/`,
      },
      { consolidateOnOpen: false, consolidateEveryMs: 0 },
    );
    const config = testConfig({ maxLimit: 500 });
    const store = await createEventStore(triples, config);
    try {
      // Leftovers of earlier runs may still be indexed; count only ours.
      const baseline = (await store.stats()).events;
      const NOW = Math.floor(Date.now() / 1000);
      const [a, b, c, d, e] = identities(5);
      const people = [a, b, c, d, e];
      const notes: NostrEvent[] = [];
      for (let i = 0; i < 200; i++) {
        notes.push(sign(people[i % 5], 1, {
          content: `live note ${run} ${i} ${
            i % 7 === 0 ? "Hello" : "world"
          } "q" \\ 🦖`,
          tags: [["t", `topic${i % 4}`], ["p", people[(i + 1) % 5].pubkey]],
          created_at: NOW - 600 + i,
        }));
      }
      const profileOld = sign(a, 0, {
        content: '{"name":"old"}',
        created_at: NOW - 900,
      });
      const profile = sign(a, 0, {
        content: '{"name":"alice"}',
        created_at: NOW - 800,
      });
      const follows = sign(a, 3, {
        tags: [["p", b.pubkey], ["p", c.pubkey]],
        created_at: NOW - 700,
      });
      const relays = sign(a, 10002, {
        tags: [["r", "wss://w.example.com", "write"], [
          "r",
          "wss://r.example.com",
          "read",
        ]],
        created_at: NOW - 700,
      });
      const v = [3, 2, 1].map((n) =>
        sign(b, 30023, {
          tags: [["d", "post"], ["title", `v${n}`]],
          content: `v${n}`,
          created_at: NOW - n * 100,
        })
      );
      const reaction = sign(c, 7, {
        content: "+",
        tags: [["e", notes[0].id]],
        created_at: NOW - 50,
      });
      const doomed = notes[10];
      const deletion = sign(
        doomed.pubkey === a.pubkey ? a : people[10 % 5],
        5,
        {
          tags: [["e", doomed.id]],
          created_at: NOW - 10,
        },
      );
      const mixed = [
        profileOld,
        profile,
        follows,
        relays,
        ...v,
        reaction,
        deletion,
      ];

      // Bursts: group commit turns each burst into one file.
      const timings: string[] = [];
      let total = 0;
      let started = performance.now();
      const burst = async (events: NostrEvent[]) => {
        const t = performance.now();
        const results = await Promise.all(events.map((ev) => store.add(ev)));
        assert(
          results.every((r) => r.status === "stored"),
          JSON.stringify(results),
        );
        timings.push(
          `${events.length} events: ${Math.round(performance.now() - t)} ms`,
        );
        total += events.length;
      };
      await burst(notes.slice(0, 100));
      await burst(notes.slice(100));
      await burst(mixed);
      const seconds = (performance.now() - started) / 1000;
      const single = sign(d, 1, { content: `single ${run}`, created_at: NOW });
      started = performance.now();
      assertEquals((await store.add(single)).status, "stored");
      const latency = Math.round(performance.now() - started);
      console.log(
        `qlever-dir live: ${total} events in ${seconds.toFixed(1)} s (${
          Math.round(total / seconds)
        } events/s) over 3 bursts [${
          timings.join("; ")
        }]; single-event latency ${latency} ms`,
      );

      // Exact reconstruction, supersession, deletion.
      for (
        const event of await store.query([{
          authors: [a.pubkey, b.pubkey],
          limit: 500,
        }])
      ) {
        assert(verifyEvent(event));
      }
      const back = await store.query([{ ids: [notes[5].id] }]);
      assertEquals(back.length, 1);
      assertEquals(back[0].content, notes[5].content);
      assertEquals(back[0].tags, notes[5].tags);
      assertEquals(back[0].sig, notes[5].sig);
      assertEquals(
        (await store.query([{ kinds: [0], authors: [a.pubkey] }])).map((x) =>
          x.id
        ),
        [profile.id],
      );
      assertEquals(
        (await store.query([{ kinds: [30023], authors: [b.pubkey] }])).map((
          x,
        ) => x.id),
        [
          v[2].id,
        ],
      );
      assertEquals(await store.query([{ ids: [doomed.id] }]), []);
      assertEquals((await store.add(doomed)).status, "duplicate");

      // Filters.
      const q = async (f: object) =>
        (await store.query([f as never])).map((x) => x.id);
      const live = notes.filter((n) => n.id !== doomed.id);
      const newest = (list: NostrEvent[], n: number) =>
        list.toSorted((x, y) =>
          y.created_at - x.created_at || (x.id < y.id ? -1 : 1)
        )
          .slice(0, n).map((x) => x.id);
      assertEquals(
        await q({ kinds: [1], search: run, limit: 20 }),
        newest([...live, single], 20),
      );
      assertEquals(
        await q({ authors: [c.pubkey], kinds: [1], limit: 500 }),
        newest(live.filter((n) => n.pubkey === c.pubkey), 500),
      );
      assertEquals(
        await q({
          "#t": ["topic2"],
          authors: people.map((p) => p.pubkey),
          limit: 500,
        }),
        newest(live.filter((n) => n.tags[0][1] === "topic2"), 500),
      );
      assertEquals(
        await q({ "#p": [a.pubkey], kinds: [1], limit: 500 }),
        newest(live.filter((n) => n.tags[1][1] === a.pubkey), 500),
      );
      assertEquals(
        await q({
          kinds: [1],
          search: run,
          since: NOW - 590,
          until: NOW - 580,
        }),
        newest(
          live.filter((n) =>
            n.created_at >= NOW - 590 && n.created_at <= NOW - 580
          ),
          500,
        ),
      );
      assertEquals(
        (await q({
          kinds: [1],
          authors: people.map((p) => p.pubkey),
          search: "hello",
          limit: 500,
        })).length,
        live.filter((n) => n.content.includes("Hello")).length,
      );
      assertEquals(
        await q({ ids: [notes[1].id, notes[2].id] }),
        newest([notes[1], notes[2]], 2),
      );
      assertEquals(await q({ authors: [] }), []);
      assertEquals((await q({ kinds: [1, 7], limit: 3 })).length, 3);
      assertEquals(
        await store.count([{ kinds: [1], search: run }]),
        live.length + 1,
      );
      assertEquals(await store.count([{ authors: [a.pubkey] }]) > 0, true);
      assertEquals((await store.stats()).events, baseline + total + 1);

      // Social lookups.
      assertEquals(
        (await store.follows([a.pubkey])).get(a.pubkey)!.sort(),
        [b.pubkey, c.pubkey].sort(),
      );
      const lists = await store.relayLists([a.pubkey]);
      assertEquals(lists.get(a.pubkey), {
        read: ["wss://r.example.com/"],
        write: ["wss://w.example.com/"],
      });

      // Consolidation against the real thing: results stay the same.
      const before = await q({ limit: 500 });
      const countBefore = await triples.size();
      const consolidated = performance.now();
      await triples.consolidate(new Date(Date.now() + 3 * DAY * 1000));
      const files = await listTree(graphDir);
      console.log(
        `qlever-dir live: consolidation ${
          Math.round(performance.now() - consolidated)
        } ms, left ${files.join(",")}`,
      );
      assertEquals(await q({ limit: 500 }), before);
      assertEquals(await triples.size(), countBefore);
      const day = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
      assertEquals(files, [`${day}.nt`]);
    } finally {
      await store.close();
      await Deno.remove(graphDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "qlever-dir live: opening waits for a migrated file to be applied",
  ignore: !url || !dir,
  fn: async () => {
    const run = `it-${crypto.randomUUID().slice(0, 8)}`;
    const graphDir = join(dir!, run);
    await Deno.mkdir(graphDir);
    try {
      const people = identities(3);
      const NOW = Math.floor(Date.now() / 1000);
      const events: NostrEvent[] = [];
      for (let i = 0; i < 300; i++) {
        events.push(sign(people[i % 3], 1, {
          content: `migrated ${i}`,
          tags: [["t", "migrated"]],
          created_at: NOW - 1000 + i,
        }));
      }
      // Written the way a migration copies `graph.nt`, then opened at once.
      await Deno.writeTextFile(
        join(graphDir, "embedded.nt"),
        events.map((e) => eventToTriples(e, { seenOn: "wss://r.example.com" }))
          .join(""),
      );
      const logs: string[] = [];
      const started = performance.now();
      const triples = await openQleverDirStore(
        {
          kind: "qlever-dir",
          queryUrl: url!,
          graphDir,
          baseUri: `${base}${run}/`,
        },
        {
          consolidateOnOpen: false,
          consolidateEveryMs: 0,
          log: (m) => logs.push(m),
        },
      );
      const opened = Math.round(performance.now() - started);
      const store = await createEventStore(triples, testConfig());
      try {
        for (const event of events) assert(store.has(event.id));
        assertEquals(
          (await store.query([{
            "#t": ["migrated"],
            authors: people.map((p) => p.pubkey),
            limit: 500,
          }])).length,
          events.length,
        );
        const probe = performance.now();
        await new SparqlClient(url!).evaluate(
          `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), ${
            JSON.stringify(base)
          })) } ORDER BY ?g LIMIT 5000`,
          "SELECT",
        );
        console.log(
          `qlever-dir live: open with a pending 300-event file took ${opened} ms (${
            logs.join(" | ")
          }); graph-name query ${Math.round(performance.now() - probe)} ms`,
        );
      } finally {
        await store.close();
      }
    } finally {
      await Deno.remove(graphDir, { recursive: true });
    }
  },
});
