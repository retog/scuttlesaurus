/**
 * Tests of the social graph: distances, mutes, the author cap, automatic recomputation, coalescing and change notification, on a real event store.
 * @module
 */
import { assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import { MemoryTripleStore, testConfig } from "../testing/mod.ts";
import { openEventStore } from "../store/mod.ts";
import {
  CutBeforeBookkeeping,
  identities,
  type Identity,
  sign,
} from "../store/test_util.ts";
import type { Config, EventStore, SocialGraph } from "../types.ts";
import { createSocialGraph } from "./mod.ts";

const NOW = Math.floor(Date.now() / 1000);

interface Fixture {
  events: EventStore;
  config: Config;
  graph: SocialGraph;
  people: Identity[];
}

/** A store, a config for the first identity as owner, and a fast graph. */
async function fixture(
  count: number,
  replication: Partial<Config["replication"]> = {},
  debounceMs = 20,
): Promise<Fixture> {
  const people = identities(count);
  const config = testConfig({ owner: people[0].pubkey });
  Object.assign(config.replication, replication);
  const events = await openEventStore(new MemoryTripleStore(), config);
  const graph = createSocialGraph(events, config, { debounceMs });
  return { events, config, graph, people };
}

async function follow(
  events: EventStore,
  who: Identity,
  followed: Identity[],
  created_at = NOW,
) {
  await events.add(
    sign(who, 3, { tags: followed.map((f) => ["p", f.pubkey]), created_at }),
  );
}

async function mute(events: EventStore, who: Identity, muted: Identity[]) {
  await events.add(
    sign(who, 10000, { tags: muted.map((m) => ["p", m.pubkey]) }),
  );
}

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

/** owner -> a -> b -> c, so distances 0, 1, 2, 3. */
async function chain(f: Fixture) {
  const [owner, a, b, c] = f.people;
  await follow(f.events, owner, [a]);
  await follow(f.events, a, [b]);
  await follow(f.events, b, [c]);
}

Deno.test("distances over three hops for hops 0, 1 and 2", async () => {
  const f = await fixture(4);
  await chain(f);
  const [owner, a, b, c] = f.people.map((p) => p.pubkey);
  try {
    for (
      const [hops, expected] of [
        [0, { [owner]: 0 }],
        [1, { [owner]: 0, [a]: 1 }],
        [2, { [owner]: 0, [a]: 1, [b]: 2 }],
        [3, { [owner]: 0, [a]: 1, [b]: 2, [c]: 3 }],
      ] as const
    ) {
      f.config.replication.hops = hops;
      await f.graph.recompute();
      assertEquals(Object.fromEntries(f.graph.authors()), expected);
      assertEquals(f.graph.distance(c), expected[c as keyof typeof expected]);
    }
  } finally {
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("the graph starts empty and there is no graph without an owner", async () => {
  const f = await fixture(2);
  try {
    await follow(f.events, f.people[0], [f.people[1]]);
    assertEquals(f.graph.authors().size, 0);
    delete f.config.owner;
    await f.graph.recompute();
    assertEquals(f.graph.authors().size, 0);
    f.config.owner = f.people[0].pubkey;
    await f.graph.recompute();
    assertEquals(f.graph.authors().size, 2);
  } finally {
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("the owner's mute list removes authors and what only they lead to", async () => {
  const f = await fixture(4);
  const [owner, a, b, c] = f.people;
  try {
    await follow(f.events, owner, [a, b]);
    await follow(f.events, a, [c]);
    await follow(f.events, b, [c]);
    await mute(f.events, owner, [b, c]);
    await f.graph.recompute();
    assertEquals(
      Object.fromEntries(f.graph.authors()),
      { [owner.pubkey]: 0, [a.pubkey]: 1 },
    );
  } finally {
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("maxAuthors keeps the candidates followed by most of the previous hop", async () => {
  // owner follows a, b, c; a and b follow x, b and c follow y, only c follows z.
  const f = await fixture(7, { hops: 2, maxAuthors: 6 });
  const [owner, a, b, c, x, y, z] = f.people;
  try {
    await follow(f.events, owner, [a, b, c]);
    await follow(f.events, a, [x]);
    await follow(f.events, b, [x, y]);
    await follow(f.events, c, [y, z]);
    await f.graph.recompute();
    // Room for two of x (2 in-links), y (2) and z (1): x and y.
    assertEquals(
      new Set(f.graph.authors().keys()),
      new Set([owner, a, b, c, x, y].map((p) => p.pubkey)),
    );

    // Equal in-links: the lower pubkey wins, whatever the insertion order.
    f.config.replication.maxAuthors = 5;
    await f.graph.recompute();
    const expected = [x, y].map((p) => p.pubkey).sort()[0];
    assertEquals(f.graph.distance(expected), 2);
    assertEquals(f.graph.authors().size, 5);

    // The cap applies to the first hop too.
    f.config.replication.maxAuthors = 2;
    await f.graph.recompute();
    assertEquals(f.graph.authors().size, 2);
    assertEquals(f.graph.distance(owner.pubkey), 0);
  } finally {
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("an unfollow shrinks the graph", async () => {
  const f = await fixture(3);
  const [owner, a, b] = f.people;
  try {
    await follow(f.events, owner, [a], NOW - 100);
    await follow(f.events, a, [b]);
    await f.graph.recompute();
    assertEquals(f.graph.authors().size, 3);
    await follow(f.events, owner, [], NOW - 50);
    await f.graph.recompute();
    assertEquals([...f.graph.authors().keys()], [owner.pubkey]);
  } finally {
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("a relevant list recomputes by itself, an irrelevant one does not", async () => {
  const f = await fixture(5, { hops: 1 });
  const [owner, a, b, stranger, c] = f.people;
  let changes = 0;
  f.graph.onChange(() => changes++);
  try {
    await follow(f.events, owner, [a]);
    await f.graph.recompute();
    assertEquals(changes, 1);

    // The owner's new follow list is relevant.
    await follow(f.events, owner, [a, b], NOW + 1);
    await until(() => f.graph.distance(b.pubkey) === 1, "the owner's list");
    assertEquals(changes, 2);

    // a is at distance 1 = hops, so a's list cannot change anything.
    await follow(f.events, a, [c]);
    // Nor can the list of somebody outside the graph.
    await follow(f.events, stranger, [c]);
    await delay(100);
    assertEquals(f.graph.distance(c.pubkey), undefined);
    assertEquals(changes, 2);

    // With one more hop a's list is relevant.
    f.config.replication.hops = 2;
    await follow(f.events, a, [c, b], NOW + 1);
    await until(() => f.graph.distance(c.pubkey) === 2, "a's list");

    // The mute list of the owner is relevant, anybody else's is not.
    await mute(f.events, owner, [c]);
    await until(
      () => f.graph.distance(c.pubkey) === undefined,
      "the mute list",
    );
  } finally {
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("a burst of lists causes one recompute", async () => {
  const f = await fixture(5, { hops: 1 }, 60);
  let changes = 0;
  f.graph.onChange(() => changes++);
  try {
    for (let i = 1; i < 5; i++) {
      await follow(f.events, f.people[0], f.people.slice(1, i + 1), NOW + i);
    }
    await until(() => f.graph.authors().size === 5, "the debounced run");
    await delay(150);
    assertEquals(changes, 1);
  } finally {
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("close cancels the pending recompute", async () => {
  const f = await fixture(2, { hops: 1 }, 30);
  try {
    await follow(f.events, f.people[0], [f.people[1]]);
    f.graph.close();
    await delay(100);
    assertEquals(f.graph.authors().size, 0);
  } finally {
    await f.events.close();
  }
});

Deno.test("concurrent recomputes coalesce into one follow-up run", async () => {
  const f = await fixture(3);
  const [owner, a, b] = f.people;
  await follow(f.events, owner, [a]);
  let runs = 0;
  // A proxy rather than a subclass: the store keeps its state in private fields.
  const events: EventStore = new Proxy(f.events, {
    get(target, property) {
      if (property === "follows") {
        return async (pubkeys: string[]) => {
          runs++;
          await delay(40);
          return target.follows(pubkeys);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const graph = createSocialGraph(events, f.config, { debounceMs: 20 });
  try {
    f.config.replication.hops = 1;
    const first = graph.recompute();
    await delay(10);
    // The store changes while the first run is in flight; every caller that
    // asked after that must see the change.
    await follow(f.events, owner, [a, b], NOW + 5);
    const second = graph.recompute();
    const third = graph.recompute();
    await first;
    assertEquals(runs, 1);
    await Promise.all([second, third]);
    assertEquals(runs, 2);
    assertEquals(graph.distance(b.pubkey), 1);
  } finally {
    graph.close();
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("onChange fires only when the graph changed and survives a throwing listener", async () => {
  const f = await fixture(2, { hops: 1 });
  const [owner, a] = f.people;
  const calls: string[] = [];
  f.graph.onChange(() => {
    calls.push("throws");
    throw new Error("listener failure");
  });
  const off = f.graph.onChange(() => calls.push("second"));
  const originalError = console.error;
  console.error = () => {};
  try {
    await f.graph.recompute();
    assertEquals(calls, ["throws", "second"]);
    await f.graph.recompute();
    assertEquals(calls.length, 2, "nothing changed");
    await follow(f.events, owner, [a]);
    await f.graph.recompute();
    assertEquals(calls.length, 4);
    off();
    await follow(f.events, owner, [], NOW + 10);
    await f.graph.recompute();
    assertEquals(calls, ["throws", "second", "throws", "second", "throws"]);
  } finally {
    console.error = originalError;
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("deleting a mute list or a follow list recomputes the graph by itself", async () => {
  const f = await fixture(3);
  const [owner, a, b] = f.people;
  try {
    await follow(f.events, owner, [a, b]);
    const muteList = sign(owner, 10000, { tags: [["p", b.pubkey]] });
    await f.events.add(muteList);
    await f.graph.recompute();
    assertEquals(f.graph.distance(b.pubkey), undefined);

    // NIP-09 by event id: the muted author comes back without a restart.
    await f.events.add(
      sign(owner, 5, { tags: [["e", muteList.id]], created_at: NOW + 1 }),
    );
    await until(() => f.graph.distance(b.pubkey) === 1, "the unmute");

    // NIP-09 by coordinate: the owner's follow list goes, and the graph with it.
    await f.events.add(
      sign(owner, 5, {
        tags: [["a", `3:${owner.pubkey}:`]],
        created_at: NOW + 2,
      }),
    );
    await until(() => f.graph.authors().size === 1, "the emptied graph");
  } finally {
    f.graph.close();
    await f.events.close();
  }
});

Deno.test("a repair after a failed insert recomputes the graph by itself", async () => {
  const [owner, bob, carol, dave] = identities(4);
  const config = testConfig({ owner: owner.pubkey });
  config.replication.hops = 2;
  // The store loses the bookkeeping of the first insert that has any, and
  // retries the repair after 200 ms when no further event comes.
  const triples = new CutBeforeBookkeeping(new MemoryTripleStore());
  const events = await openEventStore(triples, config, { repairRetryMs: 200 });
  const graph = createSocialGraph(events, config, { debounceMs: 20 });
  const quiet = console.log;
  console.log = () => {};
  try {
    await Promise.all([
      follow(events, owner, [bob, carol], NOW - 100),
      follow(events, bob, [dave]),
    ]);
    // The debounced recompute for these lists is over, so that nothing but
    // the repair can recompute the graph from here on.
    await until(() => graph.distance(dave.pubkey) === 2, "the first graph");
    // The owner drops Bob; the events are written, their bookkeeping is not.
    await follow(events, owner, [carol], NOW - 50).then(
      () => {
        throw new Error("the insert should have failed");
      },
      () => {},
    );
    assertEquals(triples.cuts, 1);
    // A recompute in the window (a configuration change, say) reads both
    // lists of the owner as current.
    await graph.recompute();
    assertEquals(graph.distance(bob.pubkey), 1);
    assertEquals(graph.distance(dave.pubkey), 2);
    // No further event: the repair on its timer is what brings the graph right.
    await until(
      () => graph.distance(bob.pubkey) === undefined,
      "the graph to drop Bob",
    );
    assertEquals(
      Object.fromEntries(graph.authors()),
      { [owner.pubkey]: 0, [carol.pubkey]: 1 },
    );
  } finally {
    console.log = quiet;
    graph.close();
    await events.close();
  }
});

Deno.test("a repair after close does not recompute the graph", async () => {
  const [owner, bob, carol] = identities(3);
  const config = testConfig({ owner: owner.pubkey });
  const triples = new CutBeforeBookkeeping(new MemoryTripleStore());
  const events = await openEventStore(triples, config, { repairRetryMs: 10 });
  let runs = 0;
  const counting: EventStore = new Proxy(events, {
    get(target, property) {
      if (property === "follows") {
        return (pubkeys: string[]) => {
          runs++;
          return target.follows(pubkeys);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const graph = createSocialGraph(counting, config, { debounceMs: 20 });
  const quiet = console.log;
  console.log = () => {};
  try {
    await follow(events, owner, [bob], NOW - 100);
    await follow(events, owner, [carol], NOW - 50).catch(() => {});
    graph.close();
    const before = runs;
    // The store's timer repairs; the closed graph does not react.
    await delay(150);
    assertEquals(
      (await events.follows([owner.pubkey])).get(owner.pubkey),
      [carol.pubkey],
    );
    assertEquals(runs, before);
  } finally {
    console.log = quiet;
    await events.close();
  }
});
