/**
 * Interrupted inserts and the repair of the bookkeeping: events that count as
 * stored (they have `nostr:sig`) but lack `supersededBy` / `deletedBy`, whether
 * left by an earlier version of the store or by a cut anywhere in the document
 * of a group; and the start-up cost of the repair on a healthy graph.
 */
import { assert, assertEquals } from "@std/assert";
import { MemoryTripleStore } from "../testing/mod.ts";
import type { EventStore, NostrEvent, TripleStore } from "../types.ts";
import { createEventStore } from "./event_store.ts";
import { eventToTriples } from "./event_triples.ts";
import { eventIri } from "../vocab.ts";
import { repairBookkeeping } from "./repair.ts";
import {
  config,
  CountingStore,
  CutBeforeBookkeeping,
  DAY,
  identities,
  isBookkeeping,
  sign,
} from "./test_util.ts";

const [alice, bob, carol] = identities(3);
const NOW = Math.floor(Date.now() / 1000);

/** A document of complete events followed by the given bookkeeping. */
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
const isSig = (line: string) => line.includes("<nostr:ontology:sig>");

Deno.test("group document: every bookkeeping triple comes after the sig of the event it points at", async () => {
  const before = sign(alice, 0, { content: "{}", created_at: NOW - 5 * DAY });
  const group = [
    sign(alice, 0, { content: "{}", created_at: NOW - 2 * DAY }),
    sign(alice, 0, { content: "{}", created_at: NOW - DAY }),
    sign(alice, 5, { tags: [["e", before.id]], created_at: NOW }),
  ];
  const recording = new Recording(new MemoryTripleStore());
  const store = await open(recording);
  await store.add(before);
  recording.inserts.length = 0;
  await Promise.all(group.map((event) => store.add(event)));
  await store.close();
  const document = lineOf(recording.inserts[0]);
  const sigAt = new Map<string, number>();
  document.forEach((line, i) => {
    if (isSig(line)) sigAt.set(line.split(" ")[0], i);
  });
  assertEquals(sigAt.size, group.length);
  const bookkeeping = document.filter(isBookkeeping);
  assert(bookkeeping.length >= 3);
  document.forEach((line, i) => {
    if (!isBookkeeping(line)) return;
    const object = line.split(" ")[2];
    assert(sigAt.get(object)! < i, `${line} before the sig of its object`);
  });
});

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

  // The order is what makes a cut harmless: all signatures come before the
  // bookkeeping, so the bookkeeping never points at an incomplete event.
  const lastSig = document.findLastIndex(isSig);
  const firstBookkeeping = document.findIndex(isBookkeeping);
  assert(firstBookkeeping > lastSig);
  assertEquals(document.filter(isBookkeeping).length, 4);

  for (let cut = 0; cut <= document.length; cut++) {
    const memory = new MemoryTripleStore();
    await memory.insert(prefix + document.slice(0, cut).join("\n") + "\n");

    // The restart repairs what the cut left out: exactly one current version
    // of every key (nothing hidden, nothing twice), the follow list not merged,
    // a deletion that is complete applied.
    const restarted = await open(memory);
    try {
      assertEquals((await current(restarted, [0])).length, 1, `profile ${cut}`);
      assertEquals((await current(restarted, [3])).length, 1, `follow ${cut}`);
      assertEquals(
        (await current(restarted, [30023])).length,
        1,
        `article ${cut}`,
      );
      assertEquals(
        (await restarted.follows([bob.pubkey])).get(bob.pubkey)?.length,
        1,
        `merge ${cut}`,
      );
      const notes = await current(restarted, [1]);
      assertEquals(
        notes.includes(doomed.id),
        !restarted.has(group[3].id),
        `deletion ${cut}`,
      );
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

Deno.test("failed insert: the next commit repairs the missing bookkeeping without a restart", async () => {
  const oldFollow = sign(bob, 3, {
    tags: [["p", alice.pubkey]],
    created_at: NOW - 3 * DAY,
  });
  const newFollow = sign(bob, 3, {
    tags: [["p", carol.pubkey]],
    created_at: NOW - DAY,
  });
  const note = sign(alice, 1, { content: "to be deleted" });
  const deletion = sign(alice, 5, { tags: [["e", note.id]] });
  const triples = new CutBeforeBookkeeping(new MemoryTripleStore());
  const store = await open(triples);
  try {
    await store.add(oldFollow);
    await store.add(note);
    const failed = await Promise.allSettled([
      store.add(newFollow),
      store.add(deletion),
    ]);
    assert(failed.every((r) => r.status === "rejected"));
    assertEquals(triples.cuts, 1);
    // Complete but without bookkeeping: both follow lists are current, and
    // nobody is told the events are stored.
    assert(!store.has(newFollow.id));
    assertEquals(
      (await store.follows([bob.pubkey])).get(bob.pubkey)?.length,
      2,
    );

    // The store works again and anything is added: the repair comes first,
    // and an event with a failing repair is not rejected for it.
    triples.failSelects = true;
    const lines = await logged(async () => {
      // The group cannot even be planned while selects fail.
      await store.add(sign(alice, 1, { content: "during the outage" })).catch(
        () => {},
      );
    });
    assertEquals(lines, []);
    triples.failSelects = false;
    const lines2 = await logged(async () => {
      await store.add(sign(alice, 1, { content: "after the outage" }));
    });
    assertEquals(lines2.length, 1);
    assert(lines2[0].includes("after a failed insert"), lines2[0]);
    assertEquals(
      (await store.follows([bob.pubkey])).get(bob.pubkey),
      [carol.pubkey],
    );
    assertEquals(
      (await store.query([{ kinds: [1], authors: [alice.pubkey] }])).filter(
        (e) => e.id === note.id,
      ),
      [],
    );
    // Offered again, the events are planned afresh and stored.
    assertEquals((await store.add(newFollow)).status, "stored");
    assertEquals((await store.add(deletion)).status, "stored");
    assertEquals(await current(store, [3]), [newFollow.id]);
  } finally {
    await store.close();
  }
});

Deno.test("failed insert: a failing repair does not reject unrelated events, and is retried", async () => {
  const oldFollow = sign(bob, 3, {
    tags: [["p", alice.pubkey]],
    created_at: NOW - 3 * DAY,
  });
  const newFollow = sign(bob, 3, {
    tags: [["p", carol.pubkey]],
    created_at: NOW - DAY,
  });
  const triples = new CutBeforeBookkeeping(new MemoryTripleStore());
  const store = await open(triples);
  try {
    await store.add(oldFollow);
    await store.add(newFollow).then(() => assert(false), () => {});
    // A store whose repair queries fail but whose group queries work: only
    // the aggregate queries of the repair carry GROUP BY.
    const select = triples.select.bind(triples);
    triples.select = (sparql: string) =>
      sparql.includes("GROUP BY")
        ? Promise.reject(new Error("repair query failed"))
        : select(sparql);
    const quiet = console.error;
    console.error = () => {};
    try {
      assertEquals(
        (await store.add(sign(alice, 1, { content: "unrelated" }))).status,
        "stored",
      );
    } finally {
      console.error = quiet;
    }
    assertEquals(
      (await store.follows([bob.pubkey])).get(bob.pubkey)?.length,
      2,
    );
    triples.select = select;
    await store.add(sign(alice, 1, { content: "later" }));
    assertEquals(
      (await store.follows([bob.pubkey])).get(bob.pubkey),
      [carol.pubkey],
    );
  } finally {
    await store.close();
  }
});

Deno.test("damage of the intermediate order: bookkeeping that points at an incomplete event", async () => {
  // A store written by the unmerged order (events without signatures, then
  // bookkeeping, then signatures) and cut before the signatures: the old
  // version is superseded by an event that is not complete. The triples cannot
  // be removed. The repair does not make the incomplete event a winner, does
  // not fail, and when the event is received, it is the current version.
  const oldFollow = sign(bob, 3, {
    tags: [["p", alice.pubkey]],
    created_at: NOW - 3 * DAY,
  });
  const newFollow = sign(bob, 3, {
    tags: [["p", carol.pubkey]],
    created_at: NOW - DAY,
  });
  const withoutSig = eventToTriples(newFollow).split("\n").filter((l) =>
    l && !isSig(l)
  ).join("\n");
  const memory = new MemoryTripleStore();
  await memory.insert(
    eventToTriples(oldFollow) + withoutSig + "\n" +
      `<${eventIri(oldFollow.id)}> <nostr:ontology:supersededBy> <${
        eventIri(newFollow.id)
      }> .\n`,
  );
  const store = await open(memory);
  try {
    assert(!store.has(newFollow.id));
    assertEquals(await current(store, [3]), []);
    assertEquals(await repairBookkeeping(memory), {
      superseded: 0,
      deleted: 0,
    });
    // Received again, it is stored (planned afresh) and current.
    assertEquals((await store.add(newFollow)).status, "stored");
    assertEquals(await current(store, [3]), [newFollow.id]);
  } finally {
    await store.close();
  }
});

Deno.test("repair: a healthy store with many `a` deletions has no candidates and no per-coordinate queries", async () => {
  const authors = identities(40);
  const memory = new MemoryTripleStore();
  const events: NostrEvent[] = [];
  authors.forEach((author, n) => {
    // Every author has a profile and a follow list older than their deletions.
    events.push(sign(author, 0, { content: "{}", created_at: NOW - 9 * DAY }));
    events.push(sign(author, 3, { created_at: NOW - 9 * DAY }));
    for (let i = 0; i < 5; i++) {
      const d = `art${n}-${i}`;
      events.push(
        sign(author, 30023, {
          tags: [["d", d]],
          created_at: NOW - 8 * DAY,
        }),
        sign(author, 30023, {
          tags: [["d", d]],
          content: "v2",
          created_at: NOW - 7 * DAY,
        }),
      );
      events.push(
        sign(author, 5, {
          tags: [["a", `30023:${author.pubkey}:${d}`]],
          created_at: NOW - 6 * DAY,
        }),
      );
    }
  });
  // Deletions by `a` of a replaceable address that was already applied.
  const store = await open(memory);
  for (const event of events) await store.add(event);
  await store.add(
    sign(authors[0], 5, {
      tags: [["a", `0:${authors[0].pubkey}:`]],
      created_at: NOW - DAY,
    }),
  );
  await store.close();

  const counting = new CountingStore(memory);
  assertEquals(await repairBookkeeping(counting), {
    superseded: 0,
    deleted: 0,
  });
  // Two queries for the keys, three for the deletion candidates; with no
  // candidate nothing is read for any deletion or coordinate.
  assertEquals(counting.selects, 5);
  assertEquals(counting.inserts, 0);
});

Deno.test("repair: a replaceable address deletion that lacks its bookkeeping is a candidate", async () => {
  const profile = sign(alice, 0, { content: "{}", created_at: NOW - 3 * DAY });
  const lateProfile = sign(alice, 0, { content: "{}", created_at: NOW });
  const list = sign(alice, 3, { created_at: NOW - 3 * DAY });
  const deletion = sign(alice, 5, {
    tags: [["a", `0:${alice.pubkey}:`], ["a", `30023:${alice.pubkey}:x`]],
    created_at: NOW - DAY,
  });
  const memory = new MemoryTripleStore();
  await memory.insert(oldDocument([profile, lateProfile, list, deletion]));
  // The kind 0 request names the old profile only; the follow list (kind 3)
  // was not named, so it is no candidate for it.
  assertEquals(await repairBookkeeping(memory), {
    superseded: 1,
    deleted: 1,
  });
  const store = await open(memory);
  try {
    assertEquals(await current(store, [0]), [lateProfile.id]);
    assertEquals(await current(store, [3]), [list.id]);
  } finally {
    await store.close();
  }
});

/** Bob's old and new follow list: the new one drops Alice for Carol. */
function followLists() {
  return [
    sign(bob, 3, { tags: [["p", alice.pubkey]], created_at: NOW - 3 * DAY }),
    sign(bob, 3, { tags: [["p", carol.pubkey]], created_at: NOW - DAY }),
  ];
}

Deno.test("failed insert: repair listeners hear of a runtime repair that wrote something, after it is in", async () => {
  const [oldFollow, newFollow] = followLists();
  const triples = new CutBeforeBookkeeping(new MemoryTripleStore());
  const store = await open(triples);
  // What a listener reads when it is called: the repaired state.
  const seen: Promise<string[] | undefined>[] = [];
  store.onRepaired(() =>
    seen.push(store.follows([bob.pubkey]).then((m) => m.get(bob.pubkey)))
  );
  try {
    await store.add(oldFollow);
    await store.add(newFollow).then(() => assert(false), () => {});
    assertEquals(seen.length, 0);
    await logged(async () => {
      await store.add(sign(alice, 1, { content: "next group" }));
    });
    assertEquals(seen.length, 1);
    assertEquals(await seen[0], [carol.pubkey]);
    // A healthy commit afterwards repairs nothing and tells nobody.
    await store.add(sign(alice, 1, { content: "later" }));
    assertEquals(seen.length, 1);
  } finally {
    await store.close();
  }
});

Deno.test("failed insert: a repair that writes nothing tells nobody", async () => {
  const triples = new CountingStore(new MemoryTripleStore());
  const store = await open(triples);
  let calls = 0;
  store.onRepaired(() => calls++);
  try {
    // The insert fails before writing anything: the repair has nothing to do.
    triples.failNextInsert = new Error("disk full");
    await store.add(sign(alice, 1, { content: "lost" })).then(
      () => assert(false),
      () => {},
    );
    const before = triples.selects;
    await store.add(sign(alice, 1, { content: "next group" }));
    assert(triples.selects > before + 4, "the repair ran");
    assertEquals(calls, 0);
  } finally {
    await store.close();
  }
});

Deno.test("failed insert: a throwing or rejecting repair listener leaves the store working", async () => {
  const [oldFollow, newFollow] = followLists();
  const triples = new CutBeforeBookkeeping(new MemoryTripleStore());
  const store = await open(triples);
  const calls: string[] = [];
  store.onRepaired(() => {
    calls.push("throws");
    throw new Error("listener failure");
  });
  store.onRepaired(async () => {
    calls.push("rejects");
    await Promise.resolve();
    throw new Error("async listener failure");
  });
  const off = store.onRepaired(() => calls.push("third"));
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    await store.add(oldFollow);
    await store.add(newFollow).then(() => assert(false), () => {});
    await logged(async () => {
      assertEquals(
        (await store.add(sign(alice, 1, { content: "next group" }))).status,
        "stored",
      );
    });
    assertEquals(calls, ["throws", "rejects", "third"]);
    assertEquals(
      (await store.follows([bob.pubkey])).get(bob.pubkey),
      [carol.pubkey],
    );
    // Both failures are logged, the rejection once it has happened.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(errors.length, 2, errors.join("\n"));
    // The committer goes on, and no repair is pending any more.
    off();
    assertEquals((await store.add(newFollow)).status, "stored");
    assertEquals(calls.length, 3);
  } finally {
    console.error = originalError;
    await store.close();
  }
});

Deno.test("failed insert: on a quiet node the repair runs from the timer and tells its listeners", async () => {
  const [oldFollow, newFollow] = followLists();
  const triples = new CutBeforeBookkeeping(new MemoryTripleStore());
  const store = await createEventStore(triples, config(), {
    repairRetryMs: 10,
  });
  let repaired!: () => void;
  const told = new Promise<void>((resolve) => repaired = resolve);
  let calls = 0;
  store.onRepaired(() => {
    calls++;
    repaired();
  });
  const original = console.log;
  console.log = () => {};
  try {
    await store.add(oldFollow);
    await store.add(newFollow).then(() => assert(false), () => {});
    assertEquals(
      (await store.follows([bob.pubkey])).get(bob.pubkey)?.length,
      2,
    );
    // No further add: only the timer can run the repair. The store's timer
    // does not keep the process alive, this one does (and bounds the wait).
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      told,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("the timer did not repair")),
          5000,
        );
      }),
    ]).finally(() => clearTimeout(deadline));
    assertEquals(
      (await store.follows([bob.pubkey])).get(bob.pubkey),
      [carol.pubkey],
    );
    // The timer stops once the repair succeeded.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(calls, 1);
  } finally {
    console.log = original;
    await store.close();
  }
});
