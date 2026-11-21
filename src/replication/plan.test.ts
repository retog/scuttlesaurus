/**
 * Tests of relay planning (NIP-65 outbox model): selection, coverage, the relay cap, tie-breaks, exclusion and bootstrap relays.
 * @module
 */
import { assertEquals } from "@std/assert";
import { type PlanInput, planRelays } from "./plan.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

const BOOT = "wss://boot.example/";
const X = "wss://x.example/";
const Y = "wss://y.example/";
const Z = "wss://z.example/";

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    authors: new Map([[A, 0], [B, 1], [C, 2]]),
    relayLists: new Map(),
    scores: new Map(),
    bootstrapRelays: [BOOT],
    maxRelays: 12,
    excluded: new Set(),
    allowPrivateRelays: true,
    ...overrides,
  };
}

const lists = (entries: Record<string, string[]>) =>
  new Map(
    Object.entries(entries).map(([author, write]) => [author, {
      read: [],
      write,
    }]),
  );

/** The plan as plain data: relay to sorted authors. */
function summary(plan: ReturnType<typeof planRelays>) {
  return Object.fromEntries(
    [...plan].map(([url, p]) => [url, [...p.authors].sort()]),
  );
}

Deno.test("authors without a relay list are asked from the bootstrap relays", () => {
  const plan = planRelays(input());
  assertEquals(summary(plan), { [BOOT]: [A, B, C] });
  assertEquals(plan.get(BOOT)?.bootstrap, true);
});

Deno.test("an author is asked from their write relays, not the bootstrap relays", () => {
  const plan = planRelays(input({
    relayLists: lists({ [A]: [X], [B]: [X], [C]: [Y] }),
  }));
  assertEquals(summary(plan), { [BOOT]: [], [X]: [A, B], [Y]: [C] });
  assertEquals(plan.get(X)?.bootstrap, false);
});

Deno.test("bootstrap relays are in the plan even when nobody needs them", () => {
  const plan = planRelays(input({
    relayLists: lists({ [A]: [X], [B]: [X], [C]: [X] }),
    bootstrapRelays: [BOOT, "WSS://Other.example"],
  }));
  assertEquals([...plan.keys()].sort(), [BOOT, "wss://other.example/", X]);
  assertEquals(plan.get("wss://other.example/")?.bootstrap, true);
});

Deno.test("an author is covered by up to two relays", () => {
  const plan = planRelays(input({
    authors: new Map([[A, 1]]),
    relayLists: lists({ [A]: [X, Y, Z] }),
  }));
  assertEquals(
    [...plan].filter(([, p]) => p.authors.has(A)).map(([url]) => url).sort(),
    [X, Y],
  );
});

Deno.test("only the first four write relays are considered", () => {
  const five = [
    "wss://1.example/",
    "wss://2.example/",
    "wss://3.example/",
    "wss://4.example/",
    "wss://5.example/",
  ];
  const plan = planRelays(input({
    authors: new Map([[A, 1]]),
    relayLists: lists({ [A]: five }),
    bootstrapRelays: [],
  }));
  assertEquals(plan.has("wss://5.example/"), false);
});

Deno.test("the relay that newly covers most authors is picked first", () => {
  // maxRelays 2: bootstrap plus one. X serves three authors, Y one.
  const plan = planRelays(input({
    authors: new Map([[A, 1], [B, 1], [C, 1], [D, 1]]),
    relayLists: lists({ [A]: [X], [B]: [X], [C]: [X], [D]: [Y] }),
    maxRelays: 2,
  }));
  assertEquals([...plan.keys()].sort(), [BOOT, X]);
});

Deno.test("authors left over by the cap fall back to the bootstrap relays", () => {
  const plan = planRelays(input({
    authors: new Map([[A, 1], [B, 1], [C, 1], [D, 1]]),
    relayLists: lists({ [A]: [X], [B]: [X], [C]: [X], [D]: [Y] }),
    maxRelays: 2,
  }));
  assertEquals(summary(plan), { [BOOT]: [D], [X]: [A, B, C] });
});

Deno.test("the number of relays never exceeds maxRelays, bootstrap relays included", () => {
  const plan = planRelays(input({
    authors: new Map([[A, 1], [B, 1], [C, 1]]),
    relayLists: lists({ [A]: [X], [B]: [Y], [C]: [Z] }),
    bootstrapRelays: [BOOT, "wss://boot2.example/"],
    maxRelays: 3,
  }));
  assertEquals(plan.size, 3);
  assertEquals(plan.has(BOOT) && plan.has("wss://boot2.example/"), true);
});

Deno.test("relay scores break ties between equally useful relays, then the URL", () => {
  const tied = {
    authors: new Map([[A, 1], [B, 1]]),
    relayLists: lists({ [A]: [X, Y], [B]: [X, Y] }),
    bootstrapRelays: [],
    maxRelays: 1,
  };
  assertEquals([...planRelays(input(tied)).keys()], [X], "URL order");

  const scores = new Map([[A, new Map([[Y, 5]])], [B, new Map([[X, 1]])]]);
  assertEquals([...planRelays(input({ ...tied, scores })).keys()], [Y]);
});

Deno.test("excluded relays are not used and their authors move on", () => {
  const plan = planRelays(input({
    authors: new Map([[A, 1], [B, 1]]),
    relayLists: lists({ [A]: [X, Y], [B]: [X] }),
    excluded: new Set([X]),
  }));
  assertEquals(plan.has(X), false);
  assertEquals(summary(plan), { [BOOT]: [B], [Y]: [A] });
});

Deno.test("an excluded bootstrap relay is left out as well", () => {
  const plan = planRelays(input({ excluded: new Set([BOOT]) }));
  assertEquals(plan.size, 0);
});

Deno.test("relay URLs are normalized and invalid ones ignored", () => {
  const plan = planRelays(input({
    authors: new Map([[A, 1]]),
    relayLists: lists({
      [A]: ["WSS://X.example", "not a url at all :", "ftp://h.example"],
    }),
    bootstrapRelays: [],
  }));
  assertEquals([...plan.keys()].sort(), ["wss://x.example/"]);
});

Deno.test("a plan is deterministic", () => {
  const args = input({
    authors: new Map([[A, 1], [B, 1], [C, 1]]),
    relayLists: lists({ [A]: [Y, X], [B]: [Z, X], [C]: [Y, Z] }),
    maxRelays: 3,
  });
  assertEquals(summary(planRelays(args)), summary(planRelays(args)));
});

Deno.test("relays from relay lists must be public unless private relays are allowed", () => {
  const strict = input({
    authors: new Map([[A, 1], [B, 1]]),
    relayLists: lists({
      [A]: ["ws://127.0.0.1:9/", "wss://10.0.0.5/", X],
      [B]: ["ws://plain.example/", "wss://localhost/"],
    }),
    allowPrivateRelays: false,
  });
  // A keeps only the public relay; B has nothing usable and falls back.
  assertEquals(summary(planRelays(strict)), { [BOOT]: [B], [X]: [A] });
  const lax = planRelays({ ...strict, allowPrivateRelays: true });
  assertEquals(lax.has("ws://127.0.0.1:9/"), true);
});

Deno.test("bootstrap relays on private addresses are always allowed", () => {
  const local = "ws://127.0.0.1:7000/";
  const plan = planRelays(input({
    authors: new Map([[A, 1]]),
    relayLists: lists({ [A]: [local] }),
    bootstrapRelays: [local],
    allowPrivateRelays: false,
  }));
  assertEquals(summary(plan), { [local]: [A] });
});
