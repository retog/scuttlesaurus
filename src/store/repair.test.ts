/**
 * Interrupted inserts and the start-up repair of the bookkeeping: events that
 * count as stored (they have `nostr:sig`) but lack `supersededBy` /
 * `deletedBy`, whether left by an earlier version of the store or by a cut
 * anywhere in the document of a group.
 */
import { assert, assertEquals } from "@std/assert";
import { MemoryTripleStore } from "../testing/mod.ts";
import type { EventStore, NostrEvent, TripleStore } from "../types.ts";
import { createEventStore } from "./event_store.ts";
import { eventToTriples } from "./event_triples.ts";
import { repairBookkeeping } from "./repair.ts";
import { config, CountingStore, DAY, identities, sign } from "./test_util.ts";

const [alice, bob, carol] = identities(3);
const NOW = Math.floor(Date.now() / 1000);

/** The document an earlier version wrote: events complete, bookkeeping last. */
const oldDocument = (events: NostrEvent[], bookkeeping = "") =>
  events.map((e) => eventToTriples(e)).join("") + bookkeeping;

const open = (triples: TripleStore): Promise<EventStore> =>
  createEventStore(triples, config());

/** Run `fn` and return what it logged with `console.log`. */
async function logged(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

const ids = (events: NostrEvent[]) => events.map((e) => e.id).sort();
const current = async (store: EventStore, kinds: number[]) =>
  ids(await store.query([{ kinds }]));

Deno.test("repair: events stored without supersededBy are superseded at start", async () => {
  const profileOld = sign(alice, 0, {
    content: "{}",
    created_at: NOW - 3 * DAY,
  });
  const profileNew = sign(alice, 0, { content: "{}", created_at: NOW - DAY });
  const profileMid = sign(alice, 0, {
    content: "{}",
    created_at: NOW - 2 * DAY,
  });
  const listOld = sign(bob, 3, {
    tags: [["p", alice.pubkey]],
    created_at: NOW - 2 * DAY,
  });
  const listNew = sign(bob, 3, {
    tags: [["p", carol.pubkey]],
    created_at: NOW - DAY,
  });
  const tied = [1, 2, 3].map((n) =>
    sign(carol, 30023, {
      tags: [["d", "post"], ["title", `v${n}`]],
      created_at: NOW - DAY,
    })
  );
  const lone = sign(carol, 30023, { tags: [["d", "other"]] });
  const note = sign(alice, 1, { content: "note" });
  const memory = new MemoryTripleStore();
  await memory.insert(oldDocument([
    profileOld,
    profileNew,
    profileMid,
    listOld,
    listNew,
    ...tied,
    lone,
    note,
  ]));

  let store!: EventStore;
  const lines = await logged(async () => {
    store = await open(memory);
  });
  try {
    assertEquals(lines.length, 1);
    // 2 + 1 + 2 superseded; ties go to the lower id (NIP-01).
    assert(lines[0].includes("5 supersededBy"), lines[0]);
    assertEquals(await current(store, [0]), [profileNew.id]);
    assertEquals(await current(store, [3]), [listNew.id]);
    const winner = [...tied].sort((a, b) => a.id < b.id ? -1 : 1)[0];
    assertEquals(
      ids(await store.query([{ kinds: [30023], authors: [carol.pubkey] }])),
      ids([winner, lone]),
    );
    // The follow list is bob's newest alone, not a merge of both.
    assertEquals(
      (await store.follows([bob.pubkey])).get(bob.pubkey),
      [carol.pubkey],
    );
    assertEquals(await current(store, [1]), [note.id]);
  } finally {
    await store.close();
  }

  // The second start has nothing to repair: silent, and nothing is written.
  const counting = new CountingStore(memory);
  const again = await logged(async () => {
    await (await open(counting)).close();
  });
  assertEquals(again, []);
  assertEquals(counting.inserts, 0);
});

Deno.test("repair: events stored without deletedBy are retracted at start", async () => {
  const note = sign(alice, 1, { content: "a", created_at: NOW - 3 * DAY });
  const other = sign(alice, 1, { content: "b", created_at: NOW - 3 * DAY });
  const bobs = sign(bob, 1, { content: "bob's", created_at: NOW - 3 * DAY });
  const article = [1, 2].map((n) =>
    sign(alice, 30023, {
      tags: [["d", "post"]],
      content: `v${n}`,
      created_at: NOW - (3 - n) * DAY,
    })
  );
  const newerArticle = sign(alice, 30023, {
    tags: [["d", "post"]],
    content: "after",
    created_at: NOW - 10,
  });
  const profile = sign(alice, 0, { content: "{}", created_at: NOW - 2 * DAY });
  const cutoff = NOW - DAY;
  const deletion = sign(alice, 5, {
    created_at: cutoff,
    tags: [
      ["e", note.id],
      ["e", bobs.id], // another author's: ignored
      ["a", `30023:${alice.pubkey}:post`],
      ["a", `0:${alice.pubkey}:`],
      ["a", `30023:${bob.pubkey}:post`], // not alice's address: ignored
    ],
  });
  const memory = new MemoryTripleStore();
  await memory.insert(oldDocument([
    note,
    other,
    bobs,
    ...article,
    newerArticle,
    profile,
    deletion,
  ]));
  const store = await open(memory);
  try {
    // Gone: the named note, the two old article versions, the old profile.
    assertEquals(
      await current(store, [1]),
      ids([other, bobs]),
    );
    // The article version newer than the request is untouched (and current).
    assertEquals(await current(store, [30023]), [newerArticle.id]);
    assertEquals(await current(store, [0]), []);
    assertEquals(await current(store, [5]), [deletion.id]);
  } finally {
    await store.close();
  }
  const counting = new CountingStore(memory);
  const again = await logged(async () => {
    await (await open(counting)).close();
  });
  assertEquals(again, []);
  assertEquals(counting.inserts, 0);
});

Deno.test("repair: nothing is written on a healthy store", async () => {
  const memory = new MemoryTripleStore();
  const counting = new CountingStore(memory);
  const store = await open(counting);
  const note = sign(alice, 1, { created_at: NOW - 5 });
  await store.add(sign(alice, 0, { content: "{}", created_at: NOW - 50 }));
  await store.add(sign(alice, 0, { content: "{}", created_at: NOW - 40 }));
  await store.add(sign(bob, 3, { tags: [["p", alice.pubkey]] }));
  await store.add(sign(carol, 30023, { tags: [["d", "x"]] }));
  await store.add(note);
  await store.add(sign(alice, 5, { tags: [["e", note.id]] }));
  await store.add(sign(alice, 5, { tags: [["a", `30023:${alice.pubkey}:x`]] }));
  const size = await memory.size();
  const inserts = counting.inserts;
  assertEquals(await repairBookkeeping(counting), {
    superseded: 0,
    deleted: 0,
  });
  assertEquals(counting.inserts, inserts);
  assertEquals(await memory.size(), size);
  const again = await logged(async () => {
    await (await open(memory)).close();
  });
  assertEquals(again, []);
  await store.close();
});

/** A triple store that records every insert and applies it. */
class Recording implements TripleStore {
  readonly inserts: string[] = [];
  constructor(readonly inner: TripleStore) {}
  insert(ntriples: string) {
    this.inserts.push(ntriples);
    return this.inner.insert(ntriples);
  }
  select(sparql: string) {
    return this.inner.select(sparql);
  }
  ask(sparql: string) {
    return this.inner.ask(sparql);
  }
  query(sparql: string) {
    return this.inner.query(sparql);
  }
  size() {
    return this.inner.size();
  }
  close() {
    return this.inner.close();
  }
}

const lineOf = (document: string) => document.split("\n").filter(Boolean);
const isBookkeeping = (line: string) =>
  line.includes("<nostr:ontology:supersededBy>") ||
  line.includes("<nostr:ontology:deletedBy>");
const isSig = (line: string) => line.includes("<nostr:ontology:sig>");

Deno.test("interrupted insert: cut at every line, then restart and retry", async () => {
  // What the store holds before the group, and the group (one burst).
  const before = [
    sign(alice, 0, { content: "{}", created_at: NOW - 5 * DAY }),
    sign(bob, 3, { tags: [["p", alice.pubkey]], created_at: NOW - 5 * DAY }),
    sign(carol, 30023, { tags: [["d", "post"]], created_at: NOW - 5 * DAY }),
    sign(alice, 1, { content: "to be deleted", created_at: NOW - 4 * DAY }),
  ];
  const doomed = before[3];
  const group = [
    sign(alice, 0, { content: "{}", created_at: NOW - 2 * DAY }),
    sign(bob, 3, { tags: [["p", carol.pubkey]], created_at: NOW - 2 * DAY }),
    sign(carol, 30023, { tags: [["d", "post"]], created_at: NOW - 2 * DAY }),
    sign(alice, 5, { tags: [["e", doomed.id]], created_at: NOW - DAY }),
    sign(bob, 1, { content: "fresh", created_at: NOW - DAY }),
  ];

  // The documents of a run that is not interrupted.
  const recording = new Recording(new MemoryTripleStore());
  const full = await open(recording);
  for (const event of before) await full.add(event);
  const prefix = recording.inserts.join("");
  recording.inserts.length = 0;
  await Promise.all(group.map((event) => full.add(event)));
  assertEquals(recording.inserts.length, 1);
  const document = lineOf(recording.inserts[0]);
  const expected = {
    profile: await current(full, [0]),
    follows: await current(full, [3]),
    articles: await current(full, [30023]),
    notes: await current(full, [1]),
  };
  await full.close();
  assertEquals(expected.notes, [group[4].id]);
  assertEquals(expected.profile, [group[0].id]);

  // The order is what makes a cut harmless: a signature never comes before
  // the bookkeeping, so a stored event never lacks the bookkeeping of its group.
  const firstSig = document.findIndex(isSig);
  const lastBookkeeping = document.findLastIndex(isBookkeeping);
  assert(lastBookkeeping >= 0 && firstSig > lastBookkeeping);
  assertEquals(document.filter(isBookkeeping).length, 4);

  for (let cut = 0; cut <= document.length; cut++) {
    const memory = new MemoryTripleStore();
    await memory.insert(prefix + document.slice(0, cut).join("\n") + "\n");

    // The restart: no version is lost twice over, none is current twice.
    const restarted = await open(memory);
    try {
      assert(
        (await current(restarted, [0])).length <= 1,
        `profile, cut ${cut}`,
      );
      assert((await current(restarted, [3])).length <= 1, `follow, cut ${cut}`);
      assert(
        (await current(restarted, [30023])).length <= 2,
        `articles, cut ${cut}`,
      );
      const follows = (await restarted.follows([bob.pubkey])).get(bob.pubkey);
      assert(follows === undefined || follows.length <= 1, `merge, cut ${cut}`);
      // A stored event of the group always has its bookkeeping.
      for (const event of group) {
        if (restarted.has(event.id)) {
          assertEquals(cut > lastBookkeeping, true, `${event.id} at ${cut}`);
        }
      }
      // The retry, as replication or the client would do it.
      for (const event of group) await restarted.add(event);
      assertEquals(
        await current(restarted, [0]),
        expected.profile,
        `cut ${cut}`,
      );
      assertEquals(
        await current(restarted, [3]),
        expected.follows,
        `cut ${cut}`,
      );
      assertEquals(
        await current(restarted, [30023]),
        expected.articles,
        `cut ${cut}`,
      );
      assertEquals(await current(restarted, [1]), expected.notes, `cut ${cut}`);
      assertEquals(
        (await restarted.follows([bob.pubkey])).get(bob.pubkey),
        [carol.pubkey],
      );
    } finally {
      await restarted.close();
    }
  }
});

Deno.test("interrupted insert: the old order is what the repair is for", async () => {
  // The same cut in the order of earlier versions (events complete, then the
  // bookkeeping): the events are known after the restart and the retry is a
  // no-op, so only the repair can fix it.
  const oldFollow = sign(bob, 3, {
    tags: [["p", alice.pubkey]],
    created_at: NOW - 3 * DAY,
  });
  const newFollow = sign(bob, 3, {
    tags: [["p", carol.pubkey]],
    created_at: NOW - DAY,
  });
  const memory = new MemoryTripleStore();
  await memory.insert(oldDocument([oldFollow, newFollow]));
  const store = await createEventStore(new CountingStore(memory), config());
  try {
    assert(store.has(newFollow.id));
    assertEquals(await store.add(newFollow), { status: "duplicate" });
    assertEquals(
      (await store.follows([bob.pubkey])).get(bob.pubkey),
      [carol.pubkey],
    );
  } finally {
    await store.close();
  }
});
