import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { QueryLimitError } from "../types.ts";
import { SparqlClient } from "./sparql_client.ts";
import { openEndpointStore } from "./sparql_endpoint_store.ts";

/**
 * An endpoint that counts requests and answers with `answer(n)`, where `n`
 * is the number of the request; `"hang"` never answers until the client
 * gives up.
 */
function endpoint(answer: (n: number) => Response | "hang") {
  let requests = 0;
  let release = () => {};
  const released = new Promise<void>((resolve) => release = resolve);
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (request) => {
      const result = answer(++requests);
      if (result !== "hang") {
        await request.text();
        return result;
      }
      await released;
      return new Response("too late", { status: 500 });
    },
  );
  return {
    get requests() {
      return requests;
    },
    url: `http://127.0.0.1:${server.addr.port}/query`,
    close: () => {
      release();
      return server.shutdown();
    },
  };
}

const OK = () =>
  new Response('{"boolean":true}', {
    headers: { "content-type": "application/sparql-results+json" },
  });

Deno.test("sparql client: a request that timed out is not retried", async () => {
  const server = endpoint(() => "hang");
  try {
    const client = new SparqlClient(server.url, { timeoutMs: 100, retries: 6 });
    let error: unknown;
    try {
      await client.evaluate("ASK {}", "ASK");
    } catch (e) {
      error = e;
    }
    assertInstanceOf(error, DOMException);
    assertEquals((error as DOMException).name, "TimeoutError");
    assertEquals(server.requests, 1);
  } finally {
    await server.close();
  }
});

Deno.test("sparql client: untrusted queries get their own limit, no retry", async () => {
  const server = endpoint(() => "hang");
  try {
    // No limit of its own, retries on: the untrusted limit still applies.
    const client = new SparqlClient(server.url, { retries: 6 });
    let error: unknown;
    try {
      await client.evaluate("ASK {}", "ASK", { untrustedTimeoutMs: 100 });
    } catch (e) {
      error = e;
    }
    assertInstanceOf(error, QueryLimitError);
    assertEquals(error.reason, "timeout");
    assertEquals(server.requests, 1);
  } finally {
    await server.close();
  }
});

Deno.test("sparql client: an untrusted query is not retried after a 503 either", async () => {
  const server = endpoint(() => new Response("restarting", { status: 503 }));
  try {
    const client = new SparqlClient(server.url, { retries: 3 });
    let failed = false;
    try {
      await client.evaluate("ASK {}", "ASK", { untrustedTimeoutMs: 1000 });
    } catch {
      failed = true;
    }
    assert(failed);
    assertEquals(server.requests, 1);
  } finally {
    await server.close();
  }
});

Deno.test("sparql client: other transient failures are still retried", async () => {
  const server = endpoint((n) =>
    n < 3 ? new Response("restarting", { status: 503 }) : OK()
  );
  try {
    const client = new SparqlClient(server.url, { retries: 3 });
    assertEquals(
      await client.evaluate("ASK {}", "ASK"),
      '{"boolean":true}',
    );
    assertEquals(server.requests, 3);
  } finally {
    await server.close();
  }
});

Deno.test("endpoint store: untrusted queries time out, trusted ones do not", async () => {
  let slow = true;
  const server = endpoint(() => slow ? "hang" : OK());
  try {
    const store = openEndpointStore(
      { kind: "sparql", queryUrl: server.url, updateUrl: server.url },
      { untrustedTimeoutMs: 100 },
    );
    let error: unknown;
    try {
      await store.query("ASK {}", { untrusted: true });
    } catch (e) {
      error = e;
    }
    assertInstanceOf(error, QueryLimitError);
    assertEquals(error.reason, "timeout");
    assertEquals(server.requests, 1);
    slow = false;
    assertEquals(await store.ask("ASK {}"), true);
    assertEquals(
      (await store.query("ASK {}", { untrusted: true })).body,
      '{"boolean":true}',
    );
  } finally {
    await server.close();
  }
});
