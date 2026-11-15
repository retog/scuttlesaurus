/// <reference lib="deno.ns" />
/**
 * The queries of the web client run against a small graph held by Oxigraph:
 * every exclusion (`MINUS`) must still remove what `FILTER NOT EXISTS` removed,
 * which depends on where it sits in the group, and the two-stage page queries
 * must put the parts of a note back together.
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { MemoryTripleStore } from "../../../src/testing/mod.ts";
import { eventToTriples } from "../../../src/store/event_triples.ts";
import { eventIri, term } from "../../../src/vocab.ts";
import { PREFIXES } from "../../../src/vocab.ts";

// The modules of the client expect a browser; `router.tsx` touches `history`
// and `location` when it is loaded.
Reflect.set(globalThis, "history", {
  scrollRestoration: "manual",
  replaceState() {},
  pushState() {},
});
Reflect.set(globalThis, "location", new URL("http://localhost:7777/"));

const feed = await import("./feed.ts");
const articles = await import("./articles.ts");
const people = await import("./people.ts");
const { notDeleted, notSuperseded } = await import("./sparql.ts");

const id = (label: string) =>
  bytesToHex(sha256(new TextEncoder().encode(label)));
const key = (label: string) => id("key " + label);
const NOW = Math.floor(Date.now() / 1000);

interface Made {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A graph of events plus the `supersededBy` / `deletedBy` bookkeeping. */
class Graph {
  readonly store = new MemoryTripleStore();
  #text = "";
  #n = 0;

  event(
    label: string,
    who: string,
    kind: number,
    tags: string[][] = [],
    content = "",
    ago = 10,
  ): Made {
    const event: Made = {
      id: id(label),
      pubkey: key(who),
      kind,
      created_at: NOW - ago - this.#n++,
      tags,
      content,
      sig: "0".repeat(128),
    };
    this.#text += eventToTriples(event);
    return event;
  }

  deleted(target: Made): void {
    this.#text += `<${eventIri(target.id)}> <${term("deletedBy")}> <${
      eventIri(id("deletion of " + target.id))
    }> .\n`;
  }

  superseded(older: Made, newer: Made): void {
    this.#text += `<${eventIri(older.id)}> <${term("supersededBy")}> <${
      eventIri(newer.id)
    }> .\n`;
  }

  async serve(): Promise<void> {
    await this.store.insert(this.#text);
    Reflect.set(
      globalThis,
      "fetch",
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const query = String(init?.body);
        if (!query.startsWith("PREFIX")) throw new Error("no prefixes");
        const { body } = await this.store.query(query);
        return new Response(body, {
          headers: { "content-type": "application/sparql-results+json" },
        });
      },
    );
  }
}

const eventsOf = (notes: { id: string }[]) => notes.map((n) => n.id);

async function build(): Promise<
  { g: Graph; by: Record<string, Made> }
> {
  const g = new Graph();
  const by: Record<string, Made> = {};
  const add = (name: string, e: Made) => (by[name] = e);
  // owner follows alice; bob is not followed
  add("list-old", g.event("list-old", "owner", 3, [["p", key("alice")]]));
  add(
    "list",
    g.event("list", "owner", 3, [["p", key("alice")], ["p", key("carol")]]),
  );
  g.superseded(by["list-old"], by["list"]);
  add(
    "alice1",
    g.event("alice1", "alice", 1, [["t", "x"]], "hello world", 100),
  );
  add("alice-del", g.event("alice-del", "alice", 1, [], "retracted", 90));
  g.deleted(by["alice-del"]);
  add(
    "alice-reply",
    g.event(
      "alice-reply",
      "alice",
      1,
      [["e", by["alice1"].id, "", "root"], ["e", by["alice1"].id, "", "reply"]],
      "re",
      80,
    ),
  );
  add("bob1", g.event("bob1", "bob", 1, [], "from bob", 70));
  add("carol1", g.event("carol1", "carol", 1, [], "from carol", 60));
  add("repost", g.event("repost", "alice", 6, [["e", by["bob1"].id]], "", 50));
  add("bob-gone", g.event("bob-gone", "bob", 1, [], "will be deleted", 45));
  add(
    "repost-gone",
    g.event("repost-gone", "alice", 6, [["e", by["bob-gone"].id]], "", 40),
  );
  g.deleted(by["bob-gone"]);
  add("like", g.event("like", "bob", 7, [["e", by["alice1"].id]], "+", 30));
  add(
    "dislike",
    g.event("dislike", "carol", 7, [["e", by["alice1"].id]], "-", 29),
  );
  add(
    "like-del",
    g.event("like-del", "dave", 7, [["e", by["alice1"].id]], "+", 28),
  );
  g.deleted(by["like-del"]);
  add("rt", g.event("rt", "carol", 6, [["e", by["alice1"].id]], "", 27));
  add(
    "mention",
    g.event("mention", "bob", 1, [["p", key("owner")]], "hi owner", 20),
  );
  // profiles: alice has an old and a current one, the old one is superseded
  add(
    "p-old",
    g.event(
      "p-old",
      "alice",
      0,
      [],
      JSON.stringify({ name: "Old Alice" }),
      1000,
    ),
  );
  add(
    "p-new",
    g.event("p-new", "alice", 0, [], JSON.stringify({ name: "Alice" }), 500),
  );
  g.superseded(by["p-old"], by["p-new"]);
  await g.serve();
  return { g, by };
}

Deno.test("the exclusion helpers are MINUS groups with their own variable", () => {
  assertEquals(
    notDeleted("?e"),
    "MINUS { ?e nostr:deletedBy ?_dele }",
  );
  assertEquals(
    notSuperseded("?list"),
    "MINUS { ?list nostr:supersededBy ?_newlist }",
  );
});

Deno.test("the network feed drops deleted notes, replies and reposts of deleted notes", async () => {
  const { by } = await build();
  const rows = await feed.fetchFeed({ scope: "network", viewer: key("owner") });
  assertEquals(
    new Set(rows.map((r: { key: string }) => r.key)),
    new Set([
      by["alice1"].id,
      by["bob1"].id,
      by["carol1"].id,
      by["mention"].id,
      by["repost"].id,
      by["rt"].id,
    ]),
  );
  const repost = rows.find((r: { key: string }) => r.key === by["repost"].id);
  assert(repost?.repostedBy);
  assertEquals(repost.id, by["bob1"].id); // the original, filled in by the second stage
  assertEquals(repost.content, "from bob");
  assertEquals(repost.repostedBy.pubkey, key("alice"));
  // newest first
  assertEquals(
    rows.map((r: { at: number }) => r.at),
    rows.map((r: { at: number }) => r.at).toSorted((a: number, b: number) =>
      b - a
    ),
  );
});

Deno.test("the following feed uses the current follow list only", async () => {
  const { by } = await build();
  const rows = await feed.fetchFeed({
    scope: "following",
    viewer: key("owner"),
  });
  // who posted each entry (the reposter, for a repost); alice and carol are
  // on the current list, bob only on nobody's
  const authors = new Set(
    rows.map((r) => r.repostedBy?.pubkey ?? r.pubkey),
  );
  assertEquals(authors.has(key("bob")), false);
  assertEquals(authors.has(key("alice")), true);
  assertEquals(authors.has(key("carol")), true);
  assertEquals(
    rows.some((r: { key: string }) => r.key === by["alice-del"].id),
    false,
  );
  assertEquals(
    await feed.fetchFollowing(key("owner")),
    new Set([key("alice"), key("carol")]),
  );
});

Deno.test("an author's notes exclude replies unless asked for", async () => {
  const { by } = await build();
  const top = await feed.fetchAuthorNotes({
    author: key("alice"),
    withReplies: false,
  });
  assertEquals(
    new Set(eventsOf(top.map((n: { key: string }) => ({ id: n.key })))),
    new Set([by["alice1"].id, by["repost"].id]),
  );
  const all = await feed.fetchAuthorNotes({
    author: key("alice"),
    withReplies: true,
  });
  assertEquals(
    all.some((n: { key: string }) => n.key === by["alice-reply"].id),
    true,
  );
  assertEquals(
    all.some((n: { key: string }) => n.key === by["alice-del"].id),
    false,
  );
});

Deno.test("fetchNotes skips deleted notes and reposts of deleted notes", async () => {
  const { by } = await build();
  const notes = await feed.fetchNotes([
    by["alice1"].id,
    by["alice-del"].id,
    by["bob-gone"].id,
    by["repost-gone"].id,
  ]);
  assertEquals(notes.map((n) => n.id), [by["alice1"].id]);
});

Deno.test("counts leave out deleted reactions and dislikes", async () => {
  const { by } = await build();
  const counts = await feed.fetchCounts([by["alice1"].id], key("owner"));
  assertEquals(counts.get(by["alice1"].id), {
    replies: 1,
    likes: 1,
    reposts: 1,
    myLike: undefined,
    myRepost: undefined,
  });
  assertEquals(await feed.fetchReactors(by["alice1"].id), [key("bob")]);
});

Deno.test("a thread leaves out deleted notes", async () => {
  const { by } = await build();
  const thread = await feed.fetchThread(by["alice1"].id);
  assertEquals(thread.focus?.id, by["alice1"].id);
  assertEquals(
    thread.replies.map((r: { note: { id: string } }) => r.note.id),
    [by["alice-reply"].id],
  );
});

Deno.test("profiles and follow lists show the current version only", async () => {
  const { by } = await build();
  const followed = await people.fetchFollowedPeople(key("owner"));
  assertEquals(
    followed.map((p: { pubkey: string; label: string }) => [p.pubkey, p.label])
      .toSorted(),
    [[key("alice"), "Alice"], [key("carol"), ""]].toSorted(),
  );
  const found = await feed.searchPeople("old alice");
  assertEquals(found, []); // the superseded profile is gone
  assertEquals((await feed.searchPeople("alice")).length, 1);
  assertEquals(by["p-new"].kind, 0);
});

Deno.test("search finds live notes and hashtags only", async () => {
  const { by } = await build();
  const text = await feed.searchNotes("retracted");
  assertEquals(text, []);
  const hello = await feed.searchNotes("hello");
  assertEquals(hello.map((n: { key: string }) => n.key), [by["alice1"].id]);
  const tagged = await feed.searchNotes("#x");
  assertEquals(tagged.map((n: { key: string }) => n.key), [by["alice1"].id]);
});

Deno.test("notifications carry the text of the note and of its target", async () => {
  const { g } = await build();
  const owner = g.event("owner-note", "owner", 1, [], "my note", 500);
  const reply = g.event(
    "reply-to-owner",
    "bob",
    1,
    [["e", owner.id, "", "reply"], ["p", owner.pubkey]],
    "answer",
    5,
  );
  const react = g.event(
    "react-to-owner",
    "carol",
    7,
    [["e", owner.id]],
    "🔥",
    4,
  );
  const gone = g.event("react-gone", "dave", 7, [["e", owner.id]], "+", 3);
  g.deleted(gone);
  await g.serve();
  const rows = await feed.fetchNotifications(key("owner"));
  const byId = new Map(rows.map((r) => [r.id, r]));
  assertEquals(byId.has(gone.id), false);
  const answer = byId.get(reply.id);
  assert(answer);
  assertEquals([answer.type, answer.excerpt], ["reply", "answer"]);
  const like = byId.get(react.id);
  assert(like);
  assertEquals([like.type, like.excerpt, like.reaction], [
    "like",
    "my note",
    "🔥",
  ]);
  assertEquals(
    await feed.hasNotificationsAfter(key("owner"), NOW - 3600),
    true,
  );
});

Deno.test("articles: the newest undeleted version, topics and comments", async () => {
  const g = new Graph();
  const tags = (
    d: string,
    title: string,
  ) => [["d", d], ["title", title], ["t", "topic"], [
    "published_at",
    String(NOW - 5000),
  ]];
  const v1 = g.event(
    "art-v1",
    "alice",
    30023,
    tags("a", "First"),
    "body one",
    5000,
  );
  const v2 = g.event(
    "art-v2",
    "alice",
    30023,
    tags("a", "Second"),
    "body two",
    4000,
  );
  g.superseded(v1, v2);
  const other = g.event(
    "art-b",
    "alice",
    30023,
    tags("b", "Gone"),
    "deleted",
    3000,
  );
  g.deleted(other);
  g.event("art-c", "bob", 30023, tags("c", "Other"), "text", 2000);
  const coordinate = `30023:${key("alice")}:a`;
  const comment = g.event(
    "comment",
    "bob",
    1111,
    [["A", coordinate], ["a", coordinate]],
    "nice",
    100,
  );
  const gone = g.event(
    "comment-gone",
    "bob",
    1111,
    [["A", coordinate], ["a", coordinate]],
    "oops",
    90,
  );
  g.deleted(gone);
  await g.serve();
  const rows = await articles.fetchArticles({ scope: "network", limit: 10 });
  assertEquals(
    rows.map((r: { title: string }) => r.title).toSorted(),
    ["Other", "Second"],
  );
  assertEquals(
    (await articles.fetchArticles({
      scope: "network",
      limit: 10,
      tag: "topic",
    })).length,
    2,
  );
  assertEquals(await articles.fetchTopTags(5), [{ tag: "topic", count: 2 }]);
  const second = rows.find((r) => r.title === "Second");
  assert(second);
  const naddr = second.naddr;
  const detail = await articles.fetchArticle(naddr);
  assert(detail);
  assertEquals([detail.title, detail.versionCount, detail.content], [
    "Second",
    2,
    "body two",
  ]);
  const comments = await articles.fetchComments(naddr);
  assertEquals(comments.map((c: { id: string }) => c.id), [comment.id]);
  assertEquals(PREFIXES.includes("nostr:"), true);
});
