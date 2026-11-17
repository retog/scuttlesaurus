import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import oxigraph from "oxigraph";
import { testConfig } from "../testing/mod.ts";
import { openEventStore, openTripleStore } from "./mod.ts";
import { INSERT_BATCH_LINES } from "./sparql_endpoint_store.ts";
import { queryForm } from "./sparql_form.ts";
import { identities, sign } from "./test_util.ts";

/** A SPARQL endpoint answered by an in-process Oxigraph store. */
function mockEndpoint(credentials?: string) {
  const store = new oxigraph.Store();
  const log: {
    path: string;
    contentType: string;
    accept: string;
    body: string;
  }[] = [];
  const fail = { updatesBeforeFailure: Infinity };
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      const body = await request.text();
      log.push({
        path: url.pathname,
        contentType: request.headers.get("content-type") ?? "",
        accept: request.headers.get("accept") ?? "",
        body,
      });
      if (
        credentials &&
        request.headers.get("authorization") !==
          "Basic " + encodeBase64(new TextEncoder().encode(credentials))
      ) {
        return new Response("unauthorized", { status: 401 });
      }
      try {
        if (url.pathname === "/update") {
          if (fail.updatesBeforeFailure-- <= 0) {
            return new Response("unavailable", { status: 503 });
          }
          const match = /^INSERT DATA \{\n([\s\S]*)\n\}$/.exec(body);
          if (
            !match ||
            request.headers.get("content-type") !== "application/sparql-update"
          ) {
            return new Response("only INSERT DATA is allowed", { status: 400 });
          }
          store.load(match[1] + "\n", { format: "application/n-triples" });
          return new Response(null, { status: 204 });
        }
        const format = request.headers.get("accept")!;
        return new Response(
          store.query(body, { results_format: format }) as string,
          { headers: { "content-type": format } },
        );
      } catch (error) {
        return new Response(String(error), { status: 400 });
      }
    },
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  return {
    store,
    log,
    /** Updates that succeed before every further one fails with 503. */
    fail,
    queryUrl: base + "/query",
    updateUrl: base + "/update",
    close: () => server.shutdown(),
  };
}

const config = (
  endpoint: ReturnType<typeof mockEndpoint>,
  credentials?: string,
) =>
  testConfig({
    store: {
      kind: "sparql",
      queryUrl: endpoint.queryUrl,
      updateUrl: endpoint.updateUrl,
      credentials,
    },
  });

Deno.test("endpoint store: insert, select, ask, query, size", async () => {
  const endpoint = mockEndpoint();
  try {
    const store = await openTripleStore(config(endpoint));
    await store.insert(
      '<urn:s1> <urn:p> "v1" .\n<urn:s2> <urn:p> "a\\"b\\n\\u0000" .\n',
    );
    assertEquals(await store.size(), 2);
    assertEquals(endpoint.store.size, 2);
    const rows = await store.select(
      "SELECT ?o WHERE { ?s <urn:p> ?o } ORDER BY ?o",
    );
    assertEquals(rows.map((r) => r.o.value), ['a"b\n\u0000', "v1"]);
    assertEquals(await store.ask('ASK { <urn:s1> <urn:p> "v1" }'), true);
    const graph = await store.query("CONSTRUCT WHERE { ?s ?p ?o }");
    assertEquals(graph.contentType, "application/n-triples");
    assertEquals(graph.body.trim().split("\n").length, 2);
    // Accept headers follow the query form; only INSERT DATA reaches /update.
    const accepts = endpoint.log.filter((l) => l.path === "/query").map((l) =>
      l.accept
    );
    assert(accepts.includes("application/n-triples"));
    assert(accepts.includes("application/sparql-results+json"));
    for (const entry of endpoint.log.filter((l) => l.path === "/update")) {
      assert(entry.body.startsWith("INSERT DATA {"));
    }
    for (const entry of endpoint.log.filter((l) => l.path === "/query")) {
      assertEquals(entry.contentType, "application/sparql-query");
    }
    await store.close();
  } finally {
    await endpoint.close();
  }
});

Deno.test("endpoint store: large inserts are split", async () => {
  const endpoint = mockEndpoint();
  try {
    const store = await openTripleStore(config(endpoint));
    const count = INSERT_BATCH_LINES * 2 + 17;
    let nt = "";
    for (let i = 0; i < count; i++) nt += `<urn:s${i}> <urn:p> "v" .\n`;
    await store.insert(nt);
    assertEquals(endpoint.log.filter((l) => l.path === "/update").length, 3);
    assertEquals(await store.size(), count);
    await store.close();
  } finally {
    await endpoint.close();
  }
});

Deno.test("endpoint store: refuses updates before sending and reports HTTP errors", async () => {
  const endpoint = mockEndpoint();
  try {
    const store = await openTripleStore(config(endpoint));
    await assertRejects(
      () => store.query("DELETE WHERE { ?s ?p ?o }"),
      Error,
      "Only SPARQL queries",
    );
    assertEquals(endpoint.log.length, 0);
    const error = await assertRejects(
      () => store.select("SELECT nonsense"),
      Error,
    );
    assert(error.message.includes("400"), error.message);
    await assertRejects(
      () => store.insert("this is not triples"),
      Error,
      "400",
    );
    await store.close();
  } finally {
    await endpoint.close();
  }
});

Deno.test("endpoint store: HTTP Basic credentials", async () => {
  const endpoint = mockEndpoint("user:pass:word");
  try {
    const store = await openTripleStore(config(endpoint, "user:pass:word"));
    await store.insert('<urn:s> <urn:p> "v" .\n');
    assertEquals(await store.size(), 1);
    await store.close();
    const anonymous = await openTripleStore(config(endpoint));
    const error = await assertRejects(() => anonymous.size(), Error);
    assert(error.message.includes("401"));
    const wrong = await openTripleStore(config(endpoint, "user:nope"));
    await assertRejects(
      () => wrong.insert('<urn:s> <urn:p> "w" .\n'),
      Error,
      "401",
    );
  } finally {
    await endpoint.close();
  }
});

Deno.test("event store works on an endpoint store", async () => {
  const endpoint = mockEndpoint();
  try {
    const cfg = config(endpoint);
    const [alice] = identities(1);
    const events = await openEventStore(await openTripleStore(cfg), cfg);
    const note = sign(alice, 1, { content: 'quote " and\nnewline \u0001' });
    assertEquals((await events.add(note)).status, "stored");
    assertEquals((await events.query([{ kinds: [1] }])).map((e) => e.content), [
      note.content,
    ]);
    await events.close();
    const again = await openEventStore(await openTripleStore(cfg), cfg);
    assert(again.has(note.id));
    await again.close();
  } finally {
    await endpoint.close();
  }
});

Deno.test("queryForm skips comments and the prologue", () => {
  assertEquals(queryForm("SELECT * WHERE {}"), "SELECT");
  assertEquals(queryForm("  \n# INSERT DATA\nask { ?s ?p ?o }"), "ASK");
  assertEquals(
    queryForm(
      "BASE <urn:b>\nPREFIX a: <urn:a#x>\n# c\nPREFIX : <urn:c>\ndescribe <urn:x>",
    ),
    "DESCRIBE",
  );
  assertEquals(
    queryForm("prefix a: <urn:a> construct { } where { }"),
    "CONSTRUCT",
  );
  for (
    const bad of [
      "INSERT DATA {}",
      "# SELECT\nDELETE WHERE {}",
      "",
      "LOAD <urn:x>",
      "PREFIX a: <urn:a>",
    ]
  ) {
    try {
      queryForm(bad);
      throw new Error("accepted " + bad);
    } catch (error) {
      assert((error as Error).message.startsWith("Only SPARQL queries"), bad);
    }
  }
});

Deno.test("endpoint store: a group cut off between requests is harmless, the retry completes it", async () => {
  const [alice, bob] = identities(2);
  const oldList = sign(bob, 3, {
    tags: [["p", alice.pubkey]],
    created_at: 1_700_000_000,
  });
  const newList = sign(bob, 3, {
    tags: [["p", "ab".repeat(32)]],
    created_at: 1_700_000_100,
  });
  const notes = Array.from(
    { length: 700 },
    (_, i) =>
      sign(alice, 1, {
        content: `n${i}`,
        tags: [..."abcdefgh"].map((t) => [t, `${i}`]),
        created_at: 1_700_000_200 + i,
      }),
  );
  const endpoint = mockEndpoint();
  try {
    const cfg = config(endpoint);
    await (await openEventStore(await openTripleStore(cfg), cfg)).add(oldList);
    let events = await openEventStore(await openTripleStore(cfg), cfg, {
      maxEvents: 1000,
    });
    // One group of more than one request; the last request fails.
    const updates = endpoint.log.filter((l) => l.path === "/update").length;
    endpoint.fail.updatesBeforeFailure = 1;
    const results = await Promise.allSettled(
      [newList, ...notes].map((event) => events.add(event)),
    );
    assert(results.every((r) => r.status === "rejected"));
    assertEquals(
      endpoint.log.filter((l) => l.path === "/update").length - updates,
      2,
    );
    // After a restart no stored event lacks its bookkeeping: nothing of the
    // failed group counts as stored (the first request held only the events'
    // triples without signatures), and the follow list is still the old one.
    endpoint.fail.updatesBeforeFailure = Infinity;
    events = await openEventStore(await openTripleStore(cfg), cfg);
    assertEquals(events.has(newList.id), false);
    assertEquals(events.has(notes[0].id), false);
    assertEquals(
      (await events.follows([bob.pubkey])).get(bob.pubkey),
      [alice.pubkey],
    );
    // The retry stores everything, with one current follow list.
    for (const event of [newList, ...notes]) {
      assertEquals((await events.add(event)).status, "stored");
    }
    assertEquals(
      (await events.follows([bob.pubkey])).get(bob.pubkey),
      ["ab".repeat(32)],
    );
    await events.close();
  } finally {
    await endpoint.close();
  }
});
