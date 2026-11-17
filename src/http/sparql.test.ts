import { assertEquals, assertStringIncludes } from "@std/assert";
import { QueryLimitError } from "../types.ts";
import { term } from "../vocab.ts";
import {
  makeFixture,
  newSigner,
  nip98Event,
  nip98Header,
  sha256Hex,
  signEvent,
} from "./test_helpers.ts";

const BASE = "http://127.0.0.1:7777";
const CONTENT = term("content");

/** A query that finds the content of every stored event. */
const CONTENTS = `SELECT ?c WHERE { ?e <${CONTENT}> ?c }`;

Deno.test("GET, POST sparql-query and POST form all answer a SELECT", async () => {
  const author = newSigner();
  const fixture = await makeFixture();
  try {
    await fixture.events.add(signEvent(author, 1, "hello sparql"));

    const get = await fixture.handler(
      new Request(`${BASE}/sparql?query=${encodeURIComponent(CONTENTS)}`),
    );
    assertEquals(get.status, 200);
    assertEquals(
      get.headers.get("content-type"),
      "application/sparql-results+json",
    );
    assertEquals(get.headers.get("cache-control"), "no-store");
    assertStringIncludes(await get.text(), "hello sparql");

    const direct = await fixture.handler(
      new Request(`${BASE}/sparql`, {
        method: "POST",
        headers: { "Content-Type": "application/sparql-query" },
        body: CONTENTS,
      }),
    );
    assertEquals(direct.status, 200);
    assertStringIncludes(await direct.text(), "hello sparql");

    const form = await fixture.handler(
      new Request(`${BASE}/sparql`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ query: CONTENTS }),
      }),
    );
    assertEquals(form.status, 200);
    assertStringIncludes(await form.text(), "hello sparql");
  } finally {
    await fixture.close();
  }
});

Deno.test("CONSTRUCT answers N-Triples", async () => {
  const fixture = await makeFixture();
  try {
    const query = "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 1";
    const response = await fixture.handler(
      new Request(`${BASE}/sparql?query=${encodeURIComponent(query)}`),
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "application/n-triples");
    await response.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("updates are refused in every form", async () => {
  const fixture = await makeFixture();
  try {
    const update = "INSERT DATA { <a:b> <a:c> <a:d> }";
    const attempts = [
      new Request(
        `${BASE}/sparql?update=${encodeURIComponent(update)}&query=${
          encodeURIComponent(CONTENTS)
        }`,
      ),
      new Request(`${BASE}/sparql`, {
        method: "POST",
        headers: { "Content-Type": "application/sparql-update" },
        body: update,
      }),
      new Request(`${BASE}/sparql`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ query: CONTENTS, update }),
      }),
      new Request(`${BASE}/sparql`, {
        method: "POST",
        headers: { "Content-Type": "application/sparql-query" },
        body: update,
      }),
    ];
    for (const request of attempts) {
      const response = await fixture.handler(request);
      assertEquals(response.status, 400);
      assertEquals(
        response.headers.get("content-type"),
        "text/plain; charset=utf-8",
      );
      const text = await response.text();
      if (request.method === "GET") {
        assertStringIncludes(text, "read-only");
      }
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("a missing or empty query is a 400", async () => {
  const fixture = await makeFixture();
  try {
    const requests = [
      new Request(`${BASE}/sparql`),
      new Request(`${BASE}/sparql?query=%20%20`),
      new Request(`${BASE}/sparql`, {
        method: "POST",
        headers: { "Content-Type": "application/sparql-query" },
        body: "   ",
      }),
    ];
    for (const request of requests) {
      const response = await fixture.handler(request);
      assertEquals(response.status, 400);
      assertStringIncludes(await response.text(), "missing query");
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("a query the store rejects is a 400 with its message as text", async () => {
  const fixture = await makeFixture();
  try {
    const response = await fixture.handler(
      new Request(
        `${BASE}/sparql?query=${encodeURIComponent("SELEC nonsense")}`,
      ),
    );
    assertEquals(response.status, 400);
    assertEquals(
      response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    const text = await response.text();
    assertEquals(text.length > 0, true);
  } finally {
    await fixture.close();
  }
});

Deno.test("other methods are 405, and oversized queries 413", async () => {
  const fixture = await makeFixture();
  try {
    const put = await fixture.handler(
      new Request(`${BASE}/sparql`, { method: "PUT", body: "x" }),
    );
    assertEquals(put.status, 405);
    assertEquals(put.headers.get("allow"), "GET, POST");
    await put.text();

    const huge = "SELECT * WHERE { ?s ?p ?o } #" + "x".repeat(70 * 1024);
    const tooBig = await fixture.handler(
      new Request(`${BASE}/sparql`, {
        method: "POST",
        headers: { "Content-Type": "application/sparql-query" },
        body: huge,
      }),
    );
    assertEquals(tooBig.status, 413);
    await tooBig.text();

    const unknownType = await fixture.handler(
      new Request(`${BASE}/sparql`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: CONTENTS,
      }),
    );
    assertEquals(unknownType.status, 415);
    await unknownType.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("with publicSparql off the owner's NIP-98 authorization is required", async () => {
  const owner = newSigner();
  const stranger = newSigner();
  const fixture = await makeFixture({
    env: { OWNER: owner.pubkey, SPARQL_PUBLIC: "off" },
  });
  try {
    const url = `${BASE}/sparql?query=${encodeURIComponent(CONTENTS)}`;

    const anonymous = await fixture.handler(new Request(url));
    assertEquals(anonymous.status, 401);
    assertEquals(
      anonymous.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    await anonymous.text();

    const notOwner = await fixture.handler(
      new Request(url, {
        headers: {
          Authorization: nip98Header(
            nip98Event(stranger, { url }),
          ),
        },
      }),
    );
    assertEquals(notOwner.status, 403);
    await notOwner.text();

    const allowed = await fixture.handler(
      new Request(url, {
        headers: { Authorization: nip98Header(nip98Event(owner, { url })) },
      }),
    );
    assertEquals(allowed.status, 200);
    await allowed.text();

    // A form POST, whose body is covered by the payload tag.
    const form = new URLSearchParams({ query: CONTENTS }).toString();
    const postUrl = `${BASE}/sparql`;
    const signedPost = await fixture.handler(
      new Request(postUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: nip98Header(
            nip98Event(owner, {
              url: postUrl,
              method: "POST",
              payload: await sha256Hex(new TextEncoder().encode(form)),
            }),
          ),
        },
        body: form,
      }),
    );
    assertEquals(signedPost.status, 200);
    await signedPost.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("queries are untrusted; limits answer 503, other failures 400", async () => {
  const fixture = await makeFixture();
  try {
    const triples = fixture.node.events.triples;
    const seen: unknown[] = [];
    let failure: Error | undefined;
    triples.query = (_sparql, options) => {
      seen.push(options);
      return failure ? Promise.reject(failure) : Promise.resolve({
        contentType: "application/sparql-results+json",
        body: "{}",
      });
    };
    const ask = () =>
      fixture.handler(
        new Request(`${BASE}/sparql?query=${encodeURIComponent("ASK {}")}`),
      );

    assertEquals((await ask()).status, 200);
    assertEquals(seen.length, 1);
    const options = seen[0] as {
      untrusted: boolean;
      client: string;
      onStart: unknown;
    };
    assertEquals(options.untrusted, true);
    // The handler is called directly here, so the peer is not known.
    assertEquals(options.client, "unknown");
    assertEquals(typeof options.onStart, "function");

    failure = new QueryLimitError("timeout", "the query took too long");
    const timeout = await ask();
    assertEquals(timeout.status, 503);
    assertEquals(timeout.headers.get("retry-after"), null);
    assertEquals(
      timeout.headers.get("content-type")?.split(";")[0],
      "text/plain",
    );
    assertEquals(await timeout.text(), "the query took too long");

    failure = new QueryLimitError("busy", "restarting", 7);
    const busy = await ask();
    assertEquals(busy.status, 503);
    assertEquals(busy.headers.get("retry-after"), "7");
    assertEquals(await busy.text(), "restarting");

    failure = new QueryLimitError("budget", "over budget", 12);
    const budget = await ask();
    assertEquals(budget.status, 429);
    assertEquals(budget.headers.get("retry-after"), "12");
    assertEquals(await budget.text(), "over budget");

    failure = new Error("syntax error");
    const bad = await ask();
    assertEquals(bad.status, 400);
    assertEquals(await bad.text(), "syntax error");
  } finally {
    await fixture.close();
  }
});
