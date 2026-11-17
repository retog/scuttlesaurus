import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { QueryLimitError } from "../types.ts";
import type { Node, QueryOptions } from "../types.ts";
import { rememberClient } from "../client_address.ts";
import { ClientBudget } from "./client_budget.ts";
import { handleSparql } from "./sparql.ts";

/** A clock the test moves by hand. */
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => void (t += ms),
  };
}

function refusal(fn: () => unknown): QueryLimitError {
  try {
    fn();
  } catch (error) {
    assertInstanceOf(error, QueryLimitError);
    return error;
  }
  throw new Error("was not refused");
}

/** Admit, start, let `ms` pass, finish. */
function run(
  budget: ClientBudget,
  c: ReturnType<typeof clock>,
  key: string,
  ms: number,
) {
  const ticket = budget.admit(key);
  ticket.start();
  c.advance(ms);
  ticket.finish();
}

Deno.test("budget: time is charged per client and recovers as the window slides", () => {
  const c = clock();
  const budget = new ClientBudget({ now: c.now });
  run(budget, c, "a", 9000);
  run(budget, c, "a", 9000);
  run(budget, c, "a", 9000); // 27 s used: over 20 s, but the third was admitted at 18 s
  const error = refusal(() => budget.admit("a"));
  assertEquals(error.reason, "budget");
  assert(error.retryAfter !== undefined && error.retryAfter >= 1);
  assert(error.retryAfter <= 60);

  // Another client is not affected.
  run(budget, c, "b", 100);

  // Time passes: the window slides and the client may ask again, but only
  // once enough of the charge has left it.
  c.advance(error.retryAfter! * 1000);
  budget.admit("a").finish(false);
  // A full window later everything is forgotten.
  c.advance(61_000);
  run(budget, c, "a", 9000);
  budget.admit("a").finish(false);
});

Deno.test("budget: the retry time says when the client can ask again", () => {
  const c = clock();
  const budget = new ClientBudget({ now: c.now });
  run(budget, c, "a", 15_000);
  c.advance(10_000);
  run(budget, c, "a", 10_000); // ends 10 s after the first
  const error = refusal(() => budget.admit("a"));
  // The first charge leaves the window 60 s after its end, 10 s ago + 10 s run.
  c.advance(error.retryAfter! * 1000 - 1000);
  refusal(() => budget.admit("a"));
  c.advance(1000);
  budget.admit("a").finish(false);
});

Deno.test("budget: a running query counts, and a queued or refused one costs nothing", () => {
  const c = clock();
  const budget = new ClientBudget({ now: c.now });
  const long = budget.admit("a");
  long.start();
  c.advance(25_000);
  refusal(() => budget.admit("a")); // running for 25 s already
  long.finish();

  const d = new ClientBudget({ now: c.now });
  const waiting = d.admit("w");
  c.advance(50_000); // waits in a queue, never starts
  waiting.finish(false);
  run(d, c, "w", 1000);
  d.admit("w").finish(false);

  // A start refused at the front of the queue throws and charges nothing.
  const e = new ClientBudget({ now: c.now });
  const first = e.admit("x");
  const second = e.admit("x");
  first.start();
  c.advance(21_000);
  refusal(() => second.start());
  second.finish(false);
  first.finish();
});

Deno.test("budget: at most so many queries of one client in flight", () => {
  const c = clock();
  const budget = new ClientBudget({ now: c.now, maxInFlight: 3 });
  const tickets = [1, 2, 3].map(() => budget.admit("a"));
  const error = refusal(() => budget.admit("a"));
  assertEquals(error.reason, "budget");
  budget.admit("b").finish(false);
  tickets[0].finish(false);
  tickets[0].finish(false); // finishing twice frees only one place
  const again = budget.admit("a");
  refusal(() => budget.admit("a"));
  again.finish(false);
  tickets[1].finish(false);
  tickets[2].finish(false);
});

Deno.test("budget: the table of clients is bounded and idle clients expire", () => {
  const c = clock();
  const budget = new ClientBudget({ now: c.now, maxClients: 10 });
  for (let i = 0; i < 100; i++) budget.admit(`c${i}`).finish(false);
  assert(budget.size <= 10);
  c.advance(120_000);
  budget.admit("late").finish(false);
  assertEquals(budget.size, 1);
  // With everybody busy the table still does not grow.
  const open = Array.from({ length: 30 }, (_, i) => budget.admit(`o${i}`));
  assert(budget.size <= 10);
  for (const t of open) t.finish(false);
});

/** A node whose store counts the queries it gets. */
function fakeNode(queries: { options?: QueryOptions }[], delay = () => {}) {
  return {
    configManager: { config: { publicSparql: true } },
    events: {
      triples: {
        query(_sparql: string, options?: QueryOptions) {
          queries.push({ options });
          options?.onStart?.();
          delay();
          return Promise.resolve({
            contentType: "application/sparql-results+json",
            body: '{"head":{"vars":[]},"results":{"bindings":[]}}',
          });
        },
      },
    },
  } as unknown as Node;
}

function request(address: string): Request {
  const r = new Request(
    "http://127.0.0.1:7777/sparql?query=SELECT%20*%20%7B%7D",
  );
  rememberClient(r, { transport: "tcp", hostname: address, port: 1 });
  return r;
}

Deno.test("/sparql: a client over budget gets 429 with Retry-After and never reaches the store", async () => {
  const c = clock();
  const budget = new ClientBudget({ now: c.now });
  const seen: { options?: QueryOptions }[] = [];
  const node = fakeNode(seen, () => c.advance(12_000));
  assertEquals(
    (await handleSparql(node, request("203.0.113.1"), budget)).status,
    200,
  );
  assertEquals(
    (await handleSparql(node, request("203.0.113.1"), budget)).status,
    200,
  );
  assertEquals(seen.length, 2);
  assertEquals(seen[0].options?.client, "203.0.113.1");
  assertEquals(seen[0].options?.untrusted, true);

  const refused = await handleSparql(node, request("203.0.113.1"), budget);
  assertEquals(refused.status, 429);
  assert(Number(refused.headers.get("retry-after")) >= 1);
  await refused.body?.cancel();
  assertEquals(seen.length, 2, "the refused query reached the store");

  // Another address is unaffected, and so is one with no known address.
  assertEquals(
    (await handleSparql(node, request("203.0.113.2"), budget)).status,
    200,
  );
  assertEquals(
    (await handleSparql(
      node,
      new Request("http://127.0.0.1:7777/sparql?query=ASK%20%7B%7D"),
      budget,
    )).status,
    200,
  );

  // The window slides: the first address may ask again.
  c.advance(61_000);
  assertEquals(
    (await handleSparql(node, request("203.0.113.1"), budget)).status,
    200,
  );
});

Deno.test("/sparql: too many queries of one client at once get 429", async () => {
  const budget = new ClientBudget({ maxInFlight: 2 });
  const gates: (() => void)[] = [];
  let reached = 0;
  const node = {
    configManager: { config: { publicSparql: true } },
    events: {
      triples: {
        query: () => {
          reached++;
          return new Promise((resolve) =>
            gates.push(() =>
              resolve({
                contentType: "application/sparql-results+json",
                body: "{}",
              })
            )
          );
        },
      },
    },
  } as unknown as Node;
  const first = handleSparql(node, request("198.51.100.7"), budget);
  const second = handleSparql(node, request("198.51.100.7"), budget);
  while (reached < 2) await new Promise((r) => setTimeout(r, 0));
  const third = await handleSparql(node, request("198.51.100.7"), budget);
  assertEquals(third.status, 429);
  assert(third.headers.has("retry-after"));
  await third.body?.cancel();
  assertEquals(reached, 2);
  for (const open of gates) open();
  assertEquals((await first).status, 200);
  assertEquals((await second).status, 200);
  // Places are free again.
  const again = handleSparql(node, request("198.51.100.7"), budget);
  while (reached < 3) await new Promise((r) => setTimeout(r, 0));
  gates.at(-1)!();
  assertEquals((await again).status, 200);
});

Deno.test("/sparql: a busy store is 503 with Retry-After and costs the client nothing", async () => {
  const budget = new ClientBudget();
  const node = {
    configManager: { config: { publicSparql: true } },
    events: {
      triples: {
        query: () => Promise.reject(new QueryLimitError("busy", "busy", 4)),
      },
    },
  } as unknown as Node;
  const response = await handleSparql(node, request("198.51.100.9"), budget);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "4");
  await response.body?.cancel();
  budget.admit("198.51.100.9").finish(false);
});
