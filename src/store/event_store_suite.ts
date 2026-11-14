/**
 * The scenarios every {@link EventStore} must pass, written once and run
 * against each triple store backend: validation, replaceable and addressable
 * supersession, deletion, every filter condition, windows, counts and the
 * social lookups.
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { verifyEvent } from "@nostr/tools/pure";
import type { Config, EventStore, Filter, NostrEvent } from "../types.ts";
import { DAY, identities, plain, sign } from "./test_util.ts";

/** Opens an event store on a fresh backend; `cleanup` releases what is left. */
export type OpenStore = (
  overrides: Partial<Config>,
) => Promise<{ store: EventStore; cleanup?: () => Promise<void> }>;

/** Register the event store tests, named with `label`, against `open`. */
export function defineEventStoreTests(label: string, open: OpenStore): void {
  const test = (name: string, fn: () => Promise<void>) =>
    Deno.test(`${label}: ${name}`, fn);

  const [alice, bob, carol] = identities(3);
  const NOW = Math.floor(Date.now() / 1000);

  async function withStore(
    fn: (store: EventStore) => Promise<void>,
    maxLimit = 500,
  ): Promise<void> {
    const { store, cleanup } = await open({ maxLimit });
    try {
      await fn(store);
    } finally {
      await store.close();
      await cleanup?.();
    }
  }

  const ids = (events: NostrEvent[]) => events.map((e) => e.id);

  async function addAll(
    store: EventStore,
    events: NostrEvent[],
  ): Promise<void> {
    for (const event of events) {
      assertEquals((await store.add(event)).status, "stored");
    }
  }

  test("add: stores, then reports duplicates; has() is synchronous", async () => {
    await withStore(async (store) => {
      const event = sign(alice, 1, { content: "hi" });
      assertEquals(store.has(event.id), false);
      assertEquals(await store.add(event), { status: "stored" });
      assertEquals(store.has(event.id), true);
      assertEquals(await store.add(event), { status: "duplicate" });
      assertEquals(store.has("not an id"), false);
      assertEquals((await store.query([{ ids: [event.id] }])).map(plain), [
        plain(event),
      ]);
    });
  });

  test("add: validation", async () => {
    await withStore(async (store) => {
      const good = sign(alice, 1, { content: "x" });
      const badSig = { ...good, sig: "0".repeat(128) };
      const reasonOf = async (event: unknown) => {
        const result = await store.add(event as NostrEvent);
        assertEquals(result.status, "rejected");
        return (result as { reason: string }).reason;
      };
      assert((await reasonOf(badSig)).startsWith("invalid:"));
      assert(
        (await reasonOf({ ...good, content: "tampered" })).startsWith(
          "invalid:",
        ),
      );
      assert(
        (await reasonOf({ ...good, id: "f".repeat(64) })).startsWith(
          "invalid:",
        ),
      );
      assert((await reasonOf({ ...good, kind: "1" })).startsWith("invalid:"));
      assert((await reasonOf(null)).startsWith("invalid:"));
      assert((await reasonOf({})).startsWith("invalid:"));
      const future = sign(alice, 1, { created_at: NOW + 16 * 60 });
      assert((await reasonOf(future)).includes("future"));
      assertEquals(
        (await store.add(sign(alice, 1, { created_at: NOW + 5 * 60 }))).status,
        "stored",
      );
      const illFormed: [string, string[][]][] = [
        ["bad \ud800", []],
        ["ok", [["t", "\udc00"]]],
      ];
      for (const [content, tags] of illFormed) {
        const event = sign(alice, 1, { content, tags });
        assert((await reasonOf(event)).includes("well-formed"));
      }
      assertEquals(store.has(good.id), false);
      // Trusting the caller skips only the signature check.
      assertEquals(
        (await store.add(badSig, { verified: true })).status,
        "stored",
      );
    });
  });

  test("add: ephemeral events are announced, not stored", async () => {
    await withStore(async (store) => {
      const seen: [string, boolean][] = [];
      store.subscribe((event, info) => seen.push([event.id, info.stored]));
      const event = sign(alice, 20001, { content: "ping" });
      assertEquals(await store.add(event), { status: "ephemeral" });
      assertEquals(store.has(event.id), false);
      assertEquals(await store.query([{}]), []);
      assertEquals(seen, [[event.id, false]]);
      assertEquals((await store.stats()).events, 0);
    });
  });

  test("subscribe: stored notifications, seenOn, unsubscribe, throwing listeners", async () => {
    await withStore(async (store) => {
      const seen: [string, string | undefined, boolean][] = [];
      store.subscribe(() => {
        throw new Error("faulty listener");
      });
      const off = store.subscribe((event, info) =>
        seen.push([event.id, info.seenOn, info.stored])
      );
      const a = sign(alice, 1, { content: "a" });
      const b = sign(alice, 1, { content: "b" });
      assertEquals(
        (await store.add(a, { seenOn: "wss://r.example.com" })).status,
        "stored",
      );
      await store.add(a);
      off();
      await store.add(b);
      assertEquals(seen, [[a.id, "wss://r.example.com", true]]);
    });
  });

  test("replaceable events: newest wins in both arrival orders", async () => {
    for (const newestFirst of [false, true]) {
      await withStore(async (store) => {
        const old = sign(alice, 0, {
          content: '{"name":"old"}',
          created_at: NOW - 100,
        });
        const mid = sign(alice, 0, {
          content: '{"name":"mid"}',
          created_at: NOW - 50,
        });
        const cur = sign(alice, 0, {
          content: '{"name":"new"}',
          created_at: NOW - 10,
        });
        const other = sign(bob, 0, {
          content: '{"name":"bob"}',
          created_at: NOW - 200,
        });
        const order = newestFirst ? [cur, mid, old] : [old, mid, cur];
        await addAll(store, [...order, other]);
        assertEquals(
          ids(await store.query([{ kinds: [0], authors: [alice.pubkey] }])),
          [cur.id],
        );
        assertEquals(ids(await store.query([{ kinds: [0] }])), [
          cur.id,
          other.id,
        ]);
        // Superseded versions stay known, so they are duplicates, not new.
        assertEquals((await store.add(old)).status, "duplicate");
        assertEquals(await store.query([{ ids: [old.id] }]), []);
      });
    }
  });

  test("replaceable events: equal created_at keeps the lower id", async () => {
    for (const lowFirst of [false, true]) {
      await withStore(async (store) => {
        const a = sign(alice, 3, { content: "a", created_at: NOW - 10 });
        const b = sign(alice, 3, { content: "b", created_at: NOW - 10 });
        const [low, high] = a.id < b.id ? [a, b] : [b, a];
        await addAll(store, lowFirst ? [low, high] : [high, low]);
        assertEquals(ids(await store.query([{ kinds: [3] }])), [low.id]);
      });
    }
  });

  test("addressable events: keyed by d tag, both orders", async () => {
    for (const newestFirst of [false, true]) {
      await withStore(async (store) => {
        const tag = (d: string) => [["d", d]];
        const v1 = sign(alice, 30023, {
          content: "v1",
          tags: tag("a b ü"),
          created_at: NOW - 100,
        });
        const v2 = sign(alice, 30023, {
          content: "v2",
          tags: tag("a b ü"),
          created_at: NOW - 50,
        });
        const other = sign(alice, 30023, {
          content: "o",
          tags: tag("other"),
          created_at: NOW - 200,
        });
        const noD = sign(alice, 30023, {
          content: "no d",
          created_at: NOW - 300,
        });
        const bobs = sign(bob, 30023, {
          content: "bob",
          tags: tag("a b ü"),
          created_at: NOW - 400,
        });
        await addAll(store, [
          ...(newestFirst ? [v2, v1] : [v1, v2]),
          other,
          noD,
          bobs,
        ]);
        const current = await store.query([{ kinds: [30023] }]);
        assertEquals(ids(current), [v2.id, other.id, noD.id, bobs.id]);
        assertEquals(
          ids(await store.query([{ kinds: [30023], "#d": ["a b ü"] }])),
          [v2.id, bobs.id],
        );
        // A later event without d tag replaces the one without.
        const noD2 = sign(alice, 30023, {
          content: "no d 2",
          created_at: NOW - 5,
        });
        await store.add(noD2);
        assert(!ids(await store.query([{ kinds: [30023] }])).includes(noD.id));
        assert(ids(await store.query([{ kinds: [30023] }])).includes(noD2.id));
      });
    }
  });

  test("deletion after the target: NIP-09 e tags", async () => {
    await withStore(async (store) => {
      const note = sign(alice, 1, { content: "oops", created_at: NOW - 100 });
      const keep = sign(alice, 1, { content: "keep", created_at: NOW - 90 });
      const bobs = sign(bob, 1, { content: "bob's", created_at: NOW - 80 });
      await addAll(store, [note, keep, bobs]);
      const deletion = sign(alice, 5, {
        tags: [["e", note.id], ["e", bobs.id]],
        created_at: NOW - 50,
      });
      await addAll(store, [deletion]);
      const left = await store.query([{ kinds: [1] }]);
      // Alice cannot delete Bob's note.
      assertEquals(ids(left), [bobs.id, keep.id]);
      // The deletion request itself is a stored, visible event.
      assertEquals(ids(await store.query([{ kinds: [5] }])), [deletion.id]);
      const result = await store.add(note);
      assertEquals(result.status, "duplicate");
    });
  });

  test("deletion before the target: the target is rejected", async () => {
    await withStore(async (store) => {
      const note = sign(alice, 1, { content: "oops", created_at: NOW - 100 });
      const deletion = sign(alice, 5, {
        tags: [["e", note.id]],
        created_at: NOW - 50,
      });
      await addAll(store, [deletion]);
      const result = await store.add(note);
      assertEquals(result.status, "rejected");
      assert((result as { reason: string }).reason.startsWith("deleted:"));
      assertEquals(store.has(note.id), false);
      assertEquals(await store.query([{ ids: [note.id] }]), []);
    });
  });

  test("deletion by another author is ignored, in both orders", async () => {
    await withStore(async (store) => {
      const note = sign(alice, 1, { content: "mine" });
      const forged = sign(bob, 5, { tags: [["e", note.id]] });
      await addAll(store, [forged]);
      assertEquals((await store.add(note)).status, "stored");
      assertEquals(ids(await store.query([{ kinds: [1] }])), [note.id]);
      const note2 = sign(alice, 1, { content: "mine too" });
      await addAll(store, [note2]);
      await addAll(store, [sign(bob, 5, { tags: [["e", note2.id]] })]);
      assertEquals(
        ids(await store.query([{ kinds: [1] }])).sort(),
        [note.id, note2.id].sort(),
      );
    });
  });

  test("deleting a deletion request has no effect", async () => {
    await withStore(async (store) => {
      const note = sign(alice, 1, { created_at: NOW - 100 });
      const deletion = sign(alice, 5, {
        tags: [["e", note.id]],
        created_at: NOW - 50,
      });
      await addAll(store, [note, deletion]);
      await addAll(store, [
        sign(alice, 5, { tags: [["e", deletion.id]], created_at: NOW - 10 }),
      ]);
      assertEquals(await store.query([{ ids: [note.id] }]), []);
      assertEquals(ids(await store.query([{ ids: [deletion.id] }])), [
        deletion.id,
      ]);
    });
  });

  test("address deletion: all versions not newer than the request", async () => {
    await withStore(async (store) => {
      const d = [["d", "post"]];
      const address = `30023:${alice.pubkey}:post`;
      const v1 = sign(alice, 30023, {
        tags: d,
        content: "v1",
        created_at: NOW - 300,
      });
      const v2 = sign(alice, 30023, {
        tags: d,
        content: "v2",
        created_at: NOW - 200,
      });
      const other = sign(alice, 30023, {
        tags: [["d", "other"]],
        created_at: NOW - 250,
      });
      await addAll(store, [v1, v2, other]);
      const deletion = sign(alice, 5, {
        tags: [["a", address]],
        created_at: NOW - 100,
      });
      await addAll(store, [deletion]);
      assertEquals(ids(await store.query([{ kinds: [30023] }])), [other.id]);
      // A version older than the deletion is refused, a newer one accepted.
      const late = sign(alice, 30023, {
        tags: d,
        content: "late",
        created_at: NOW - 150,
      });
      assertEquals((await store.add(late)).status, "rejected");
      const newer = sign(alice, 30023, {
        tags: d,
        content: "newer",
        created_at: NOW - 50,
      });
      assertEquals((await store.add(newer)).status, "stored");
      assertEquals(ids(await store.query([{ kinds: [30023] }])), [
        newer.id,
        other.id,
      ]);
    });
  });

  test("address deletion arriving first, and for another author's address", async () => {
    await withStore(async (store) => {
      const d = [["d", "post"]];
      const deletion = sign(alice, 5, {
        tags: [["a", `30023:${alice.pubkey}:post`], [
          "a",
          `30023:${bob.pubkey}:post`,
        ]],
        created_at: NOW - 100,
      });
      await addAll(store, [deletion]);
      const mine = sign(alice, 30023, { tags: d, created_at: NOW - 200 });
      assertEquals((await store.add(mine)).status, "rejected");
      const bobs = sign(bob, 30023, { tags: d, created_at: NOW - 200 });
      assertEquals((await store.add(bobs)).status, "stored");
    });
  });

  test("address deletion of a replaceable event", async () => {
    await withStore(async (store) => {
      const profile = sign(alice, 0, { content: "{}", created_at: NOW - 100 });
      await addAll(store, [profile]);
      await addAll(store, [
        sign(alice, 5, {
          tags: [["a", `0:${alice.pubkey}:`]],
          created_at: NOW - 50,
        }),
      ]);
      assertEquals(await store.query([{ kinds: [0] }]), []);
    });
  });

  test("concurrent adds of one replaceable key leave exactly one head", async () => {
    await withStore(async (store) => {
      const events = Array.from(
        { length: 12 },
        (_, i) =>
          sign(alice, 10002, {
            content: String(i),
            created_at: NOW - 1000 + (i * 7) % 12,
          }),
      );
      const results = await Promise.all(events.map((e) => store.add(e)));
      assert(results.every((r) => r.status === "stored"));
      const current = await store.query([{ kinds: [10002] }]);
      assertEquals(current.length, 1);
      const expected = [...events].sort((a, b) =>
        b.created_at - a.created_at || (a.id < b.id ? -1 : 1)
      )[0];
      assertEquals(current[0].id, expected.id);
    });
  });

  test("query: every filter condition", async () => {
    await withStore(async (store) => {
      const e1 = sign(alice, 1, {
        content: "Hello World",
        tags: [["t", "greeting"], ["p", bob.pubkey]],
        created_at: NOW - 400,
      });
      const e2 = sign(bob, 1, {
        content: "goodbye",
        tags: [["t", "farewell"], ["e", e1.id]],
        created_at: NOW - 300,
      });
      const e3 = sign(alice, 7, {
        content: "+",
        tags: [["e", e1.id]],
        created_at: NOW - 200,
      });
      const e4 = sign(carol, 1, {
        content: "HELLO again",
        tags: [["T", "greeting"]],
        created_at: NOW - 100,
      });
      await addAll(store, [e1, e2, e3, e4]);
      const q = async (f: Filter) => ids(await store.query([f]));
      assertEquals(await q({}), [e4.id, e3.id, e2.id, e1.id]);
      assertEquals(await q({ ids: [e2.id, e3.id] }), [e3.id, e2.id]);
      assertEquals(await q({ authors: [alice.pubkey] }), [e3.id, e1.id]);
      assertEquals(await q({ kinds: [1] }), [e4.id, e2.id, e1.id]);
      assertEquals(
        await q({ kinds: [1, 7], authors: [alice.pubkey, bob.pubkey] }),
        [e3.id, e2.id, e1.id],
      );
      assertEquals(await q({ "#t": ["greeting", "farewell"] }), [e2.id, e1.id]);
      assertEquals(await q({ "#T": ["greeting"] }), [e4.id]);
      assertEquals(await q({ "#e": [e1.id] }), [e3.id, e2.id]);
      assertEquals(await q({ "#p": [bob.pubkey], kinds: [1] }), [e1.id]);
      assertEquals(await q({ "#t": ["greeting"], "#p": [bob.pubkey] }), [
        e1.id,
      ]);
      assertEquals(await q({ since: NOW - 300 }), [e4.id, e3.id, e2.id]);
      assertEquals(await q({ until: NOW - 300 }), [e2.id, e1.id]);
      assertEquals(await q({ since: NOW - 300, until: NOW - 200 }), [
        e3.id,
        e2.id,
      ]);
      assertEquals(await q({ since: NOW - 300, until: NOW - 300 }), [e2.id]);
      assertEquals(await q({ search: "hello" }), [e4.id, e1.id]);
      assertEquals(await q({ search: "  GOODBYE " }), [e2.id]);
      assertEquals(await q({ search: "hello", authors: [alice.pubkey] }), [
        e1.id,
      ]);
      assertEquals(await q({ search: "nothing like it" }), []);
      assertEquals(await q({ limit: 2 }), [e4.id, e3.id]);
      assertEquals(
        await q({
          authors: [alice.pubkey, bob.pubkey, carol.pubkey],
          limit: 3,
        }),
        [e4.id, e3.id, e2.id],
      );
      assertEquals(await q({ limit: 0 }), []);
      // Quotes and special characters in tag values are plain data.
      assertEquals(await q({ "#t": ['x" } ?s ?p ?o { "'] }), []);
    });
  });

  test("query: empty lists match nothing, malformed values are ignored", async () => {
    await withStore(async (store) => {
      const e = sign(alice, 1, { tags: [["t", "x"]] });
      await addAll(store, [e]);
      const q = async (f: Filter) => ids(await store.query([f]));
      assertEquals(await q({ ids: [] }), []);
      assertEquals(await q({ authors: [] }), []);
      assertEquals(await q({ kinds: [] }), []);
      assertEquals(await q({ "#t": [] }), []);
      assertEquals(await q({ ids: ["zz", "not hex"] }), []);
      assertEquals(await q({ authors: ['x"> ?'] }), []);
      assertEquals(await q({ ids: ["zz", e.id] }), [e.id]);
      assertEquals(await q({ authors: ["nope", alice.pubkey] }), [e.id]);
      assertEquals(await q({ kinds: [1.5, 1] }), [e.id]);
      assertEquals(await q({ since: 10, until: 5 }), []);
      assertEquals(await store.query([]), []);
    });
  });

  test("query: union of filters is deduplicated and sorted; limits are per filter", async () => {
    await withStore(async (store) => {
      const events = Array.from(
        { length: 6 },
        (_, i) =>
          sign(i % 2 ? alice : bob, 1, {
            content: `n${i}`,
            created_at: NOW - 600 + i * 100,
          }),
      );
      await addAll(store, events);
      const result = await store.query([
        { authors: [alice.pubkey], limit: 2 },
        { authors: [bob.pubkey], limit: 1 },
        { kinds: [1], limit: 2 },
      ]);
      // alice: n5, n3; bob: n4; kind 1: n5, n4 — union n5 n4 n3.
      assertEquals(result.map((e) => e.content), ["n5", "n4", "n3"]);
      assertEquals((await store.query([{}, {}])).length, 6);
    });
  });

  test("query: equal created_at orders by id and cuts ties by id", async () => {
    await withStore(async (store) => {
      const events = Array.from(
        { length: 8 },
        (_, i) =>
          sign(alice, 1, { content: `same ${i}`, created_at: NOW - 100 }),
      );
      await addAll(store, events);
      const sorted = ids(events).sort();
      for (const filter of [{ authors: [alice.pubkey] }, { kinds: [1] }]) {
        assertEquals(
          ids(await store.query([{ ...filter, limit: 3 }])),
          sorted.slice(0, 3),
        );
        assertEquals(ids(await store.query([filter])), sorted);
      }
    });
  });

  test("query: maxLimit caps filters, default limit is maxLimit", async () => {
    await withStore(async (store) => {
      await addAll(
        store,
        Array.from(
          { length: 10 },
          (_, i) =>
            sign(alice, 1, { content: `${i}`, created_at: NOW - 1000 + i }),
        ),
      );
      assertEquals((await store.query([{}])).length, 4);
      assertEquals((await store.query([{ limit: 100 }])).length, 4);
      assertEquals(
        (await store.query([{ authors: [alice.pubkey], limit: 100 }])).length,
        4,
      );
      assertEquals((await store.query([{ limit: 2 }])).length, 2);
      assertEquals(await store.count([{}]), 10);
    }, 4);
  });

  test("query: unselective filters use windows across days and a gap of months", async () => {
    await withStore(async (store) => {
      const offsets = [0, 0, 1, 2, 3, 5, 9, 17, 33, 200, 201, 202, 400, 800];
      const events = offsets.map((days, i) =>
        sign(i % 2 ? alice : bob, 1, {
          content: `d${days}-${i}`,
          created_at: NOW - days * DAY - i,
        })
      );
      const other = sign(alice, 7, { content: "+", created_at: NOW - 3 * DAY });
      await addAll(store, [...events, other]);
      const newest = [...events].sort((a, b) => b.created_at - a.created_at);

      for (const limit of [1, 3, 5, 9, 10, 14, 50]) {
        const result = await store.query([{ kinds: [1], limit }]);
        assertEquals(
          ids(result),
          ids(newest.slice(0, limit)),
          `limit ${limit}`,
        );
      }
      // since / until windows, including ones inside the months-long gap.
      const between = (since: number, until: number) =>
        ids(
          newest.filter((e) => e.created_at >= since && e.created_at <= until),
        );
      for (
        const [since, until] of [
          [NOW - 40 * DAY, NOW],
          [NOW - 150 * DAY, NOW - 60 * DAY],
          [NOW - 500 * DAY, NOW - 100 * DAY],
          [NOW - 3000 * DAY, NOW - 1000 * DAY],
          [NOW - 2 * DAY, NOW + 100 * DAY],
        ]
      ) {
        assertEquals(
          ids(await store.query([{ kinds: [1], since, until }])),
          between(since, until),
          `${since}..${until}`,
        );
      }
      assertEquals(
        ids(await store.query([{ since: NOW - 1000 * DAY, kinds: [7] }])),
        [other.id],
      );
      assertEquals(
        (await store.query([{ kinds: [1], until: NOW - 10000 * DAY }])).length,
        0,
      );
      assertEquals(
        (await store.query([{ kinds: [1], since: NOW + 10 * DAY }])).length,
        0,
      );
      // Search over windows.
      assertEquals(
        (await store.query([{ search: "d800", limit: 5 }])).map((e) =>
          e.content
        ),
        ["d800-13"],
      );
      assertEquals(await store.count([{ kinds: [1] }]), events.length);
      assertEquals(
        await store.count([{ kinds: [1], since: NOW - 40 * DAY }]),
        9,
      );
    });
  });

  test("count: ignores limit, deduplicates across filters, skips hidden events", async () => {
    await withStore(async (store) => {
      const a = sign(alice, 1, { created_at: NOW - 10 });
      const b = sign(alice, 1, { created_at: NOW - 20 });
      const c = sign(bob, 7, { created_at: NOW - 30 });
      const profile1 = sign(alice, 0, { created_at: NOW - 40 });
      const profile2 = sign(alice, 0, { created_at: NOW - 5 });
      await addAll(store, [a, b, c, profile1, profile2]);
      await store.add(
        sign(alice, 5, { tags: [["e", b.id]], created_at: NOW - 1 }),
      );
      assertEquals(await store.count([{ kinds: [1], limit: 1 }]), 1);
      assertEquals(
        await store.count([{ authors: [alice.pubkey], limit: 1 }]),
        3,
      );
      assertEquals(
        await store.count([{ kinds: [1] }, { authors: [alice.pubkey] }]),
        3,
      );
      assertEquals(await store.count([{ kinds: [0] }]), 1);
      assertEquals(await store.count([{ ids: [] }]), 0);
      assertEquals(await store.count([]), 0);
    });
  });

  test("awkward events are reconstructed exactly and verify", async () => {
    await withStore(async (store) => {
      const cases: [string, string[][]][] = [
        ["", []],
        ['quote " backslash \\ \\n', [["t", 'a"b']]],
        ["line\nbreak\r\n\ttab", [["t", "x\ny"]]],
        ["🦖 ‮שלום‬", [["emoji", "🦖"]]],
        ["nul\u0000 bell\u0007 esc\u001b del\u007f", [["t", "\u0000"]]],
        ["x", [["t", ""], ["", ""], ["e", ""], ["x"], []]],
        ["x", [["d", "héllo wörld 🦖 with  spaces"], ["title", ""]]],
      ];
      const events = cases.map(([content, tags], i) =>
        sign(alice, i === cases.length - 1 ? 30023 : 1, {
          content,
          tags,
          created_at: NOW - 100 + i,
        })
      );
      await addAll(store, events);
      for (const event of events) {
        const [back] = await store.query([{ ids: [event.id] }]);
        assertEquals(plain(back), plain(event));
        assert(verifyEvent(back));
      }
      for (const event of await store.query([{}])) assert(verifyEvent(event));
    });
  });

  test("hostile tag values are stored safely", async () => {
    await withStore(async (store) => {
      const evil = [
        '"> . <urn:x> <urn:y> "',
        "\u0000\u001f",
        '<>"{}|^`\\',
        "a b",
        "\n",
        "javascript:alert(1)",
      ];
      const events: NostrEvent[] = [];
      let n = 0;
      for (const value of evil) {
        for (
          const kind of [0, 1, 3, 5, 7, 6, 1111, 10000, 10002, 10063, 30023]
        ) {
          const tags = [
            "e",
            "p",
            "a",
            "q",
            "E",
            "A",
            "r",
            "server",
            "image",
            "title",
            "d",
            "t",
            "published_at",
          ]
            .map((name) => [name, value]);
          const content = kind === 0
            ? JSON.stringify({ name: value, picture: value, banner: value })
            : value;
          events.push(
            sign(alice, kind, { content, tags, created_at: NOW - 5000 + n++ }),
          );
        }
      }
      for (const event of events) {
        assertEquals(
          (await store.add(event)).status,
          "stored",
          JSON.stringify(event),
        );
      }
      for (const event of events) {
        const found = await store.query([{
          "#d": [event.tags.find((t) => t[0] === "d")![1]],
          ids: [event.id],
        }]);
        assert(found.length <= 1);
      }
      assertEquals((await store.stats()).events, events.length);
    });
  });

  test("follows, mutes, relayLists and relayScores use current lists only", async () => {
    await withStore(async (store) => {
      const oldFollows = sign(alice, 3, {
        tags: [["p", bob.pubkey]],
        created_at: NOW - 100,
      });
      const follows = sign(alice, 3, {
        tags: [["p", bob.pubkey], ["p", carol.pubkey], ["p", "zz"]],
        created_at: NOW - 50,
      });
      const bobFollowsNobody = sign(bob, 3, { created_at: NOW - 50 });
      const mutes = sign(alice, 10000, {
        tags: [["p", carol.pubkey]],
        created_at: NOW - 50,
      });
      const relays = sign(alice, 10002, {
        tags: [["r", "wss://both.example.com"], [
          "r",
          "wss://r.example.com/",
          "read",
        ], ["r", "wss://w.example.com", "write"]],
        created_at: NOW - 50,
      });
      const oldRelays = sign(alice, 10002, {
        tags: [["r", "wss://old.example.com"]],
        created_at: NOW - 500,
      });
      await addAll(store, [
        oldFollows,
        follows,
        bobFollowsNobody,
        mutes,
        relays,
        oldRelays,
      ]);

      const result = await store.follows([
        alice.pubkey,
        bob.pubkey,
        carol.pubkey,
        "junk",
      ]);
      assertEquals(
        [...result.keys()].sort(),
        [alice.pubkey, bob.pubkey].sort(),
      );
      assertEquals(
        result.get(alice.pubkey)!.sort(),
        [bob.pubkey, carol.pubkey].sort(),
      );
      assertEquals(result.get(bob.pubkey), []);
      assertEquals(await store.mutes(alice.pubkey), [carol.pubkey]);
      assertEquals(await store.mutes(bob.pubkey), []);
      const lists = await store.relayLists([alice.pubkey, bob.pubkey]);
      assertEquals([...lists.keys()], [alice.pubkey]);
      assertEquals(lists.get(alice.pubkey)!.read.sort(), [
        "wss://both.example.com/",
        "wss://r.example.com/",
      ]);
      assertEquals(lists.get(alice.pubkey)!.write.sort(), [
        "wss://both.example.com/",
        "wss://w.example.com/",
      ]);

      // A deleted list is no longer current, and the older one stays superseded.
      await store.add(
        sign(alice, 5, { tags: [["e", follows.id]], created_at: NOW - 10 }),
      );
      assertEquals(
        (await store.follows([alice.pubkey])).has(alice.pubkey),
        false,
      );
    });
  });

  test("follows chunks large inputs", async () => {
    await withStore(async (store) => {
      const many = identities(700);
      const list = sign(alice, 3, {
        tags: many.slice(0, 650).map((m) => ["p", m.pubkey]),
      });
      await addAll(store, [list]);
      const result = await store.follows([
        alice.pubkey,
        ...many.map((m) => m.pubkey),
      ]);
      assertEquals(result.get(alice.pubkey)!.length, 650);
      assertEquals((await store.follows(many.map((m) => m.pubkey))).size, 0);
    });
  });

  test("relayScores counts first-seen relays per author", async () => {
    await withStore(async (store) => {
      await store.add(sign(alice, 1, { content: "1" }), {
        seenOn: "wss://A.example.com",
      });
      await store.add(sign(alice, 1, { content: "2" }), {
        seenOn: "wss://a.example.com/",
      });
      await store.add(sign(alice, 1, { content: "3" }), {
        seenOn: "wss://b.example.com",
      });
      await store.add(sign(alice, 1, { content: "4" }));
      const gone = sign(alice, 1, { content: "5", created_at: NOW - 10 });
      await store.add(gone, { seenOn: "wss://c.example.com" });
      await store.add(sign(alice, 5, { tags: [["e", gone.id]] }));
      await store.add(sign(bob, 1, { content: "bob" }), {
        seenOn: "wss://b.example.com",
      });
      const scores = await store.relayScores([
        alice.pubkey,
        bob.pubkey,
        carol.pubkey,
      ]);
      assertEquals(
        scores.get(alice.pubkey),
        new Map([["wss://a.example.com/", 2], ["wss://b.example.com/", 1]]),
      );
      assertEquals(
        scores.get(bob.pubkey),
        new Map([["wss://b.example.com/", 1]]),
      );
      assertEquals(scores.has(carol.pubkey), false);
    });
  });

  test("stats counts events, triples and authors", async () => {
    await withStore(async (store) => {
      assertEquals(await store.stats(), { events: 0, triples: 0, authors: 0 });
      await addAll(store, [
        sign(alice, 1),
        sign(alice, 1, { content: "b" }),
        sign(bob, 1),
      ]);
      const stats = await store.stats();
      assertEquals(stats.events, 3);
      assertEquals(stats.authors, 2);
      assert(stats.triples >= 3 * 5);
    });
  });

  test("close waits for pending adds and rejects later ones", async () => {
    const { store, cleanup } = await open({});
    try {
      const pending = store.add(sign(alice, 1));
      await store.close();
      assertEquals((await pending).status, "stored");
      await assertRejects(
        () => store.add(sign(alice, 1, { content: "late" })),
        Error,
        "closed",
      );
      await store.close();
    } finally {
      await cleanup?.();
    }
  });
}
