/**
 * Tests of the seed world: determinism, valid signatures, the ranges of its
 * counts, the references between events, the follow structure and the text.
 * @module
 */
import { createHash } from "node:crypto";
import { verifyEvent } from "@nostr/tools/pure";
import { assert, assertEquals } from "@std/assert";
import { distancesFrom } from "./graph.ts";
import type { Persona, SignedEvent, Template, World } from "./model.ts";
import { Renderer } from "./template.ts";
import { buildWorld, summarize } from "./world.ts";

const DAY = 86400;
/** A fixed hour, so that the tests do not depend on the clock. */
const NOW = 1_794_528_000;

const env = {
  mediaUrl: (id: string) =>
    `https://blossom.example/${id.replace(/[^a-z0-9]/gi, "")}`,
};

function render(world: World): Map<string, SignedEvent> {
  const renderer = new Renderer(world.templates, env);
  return new Map(world.templates.map((t) => [t.key, renderer.event(t.key)]));
}

function byKey(world: World): Map<string, Template> {
  return new Map(world.templates.map((t) => [t.key, t]));
}

function tierOf(world: World): Map<string, Persona["tier"]> {
  return new Map(world.personas.map((p) => [p.handle, p.tier]));
}

/** Every `{{event:K}}` and `{{json:K}}` a template refers to. */
function referencesOf(t: Template): string[] {
  const text = [t.content, ...t.tags.flatMap((tag) => tag)].join("\n");
  return [...text.matchAll(/\{\{(?:event|json|nevent):([^}]+)\}\}/g)].map((m) =>
    m[1]
  );
}

Deno.test("two builds with the same hour are deep-equal", () => {
  const first = buildWorld({ now: NOW });
  const second = buildWorld({ now: NOW });
  assertEquals(first, second);
});

Deno.test("a different hour keeps the cast and moves the times", () => {
  const first = buildWorld({ now: NOW });
  const later = buildWorld({ now: NOW + 3600 });
  assertEquals(first.personas, later.personas);
  assertEquals(first.follows, later.follows);
  assertEquals(first.mutes, later.mutes);
  const laterKeys = byKey(later);
  for (const t of first.templates.filter((x) => x.key.startsWith("profile:"))) {
    const other = laterKeys.get(t.key);
    assert(other, `${t.key} exists in both worlds`);
    assertEquals(other.createdAt - t.createdAt, 3600, t.key);
  }
});

Deno.test("every event signs and verifies", () => {
  const world = buildWorld({ now: NOW });
  for (const [key, event] of render(world)) {
    assert(verifyEvent(event), `${key} verifies`);
  }
});

Deno.test("rendered events carry no placeholder left over", () => {
  const world = buildWorld({ now: NOW });
  for (const [key, event] of render(world)) {
    const text = event.content + event.tags.flat().join("");
    assert(!text.includes("{{"), `${key} has a placeholder left`);
  }
});

Deno.test("counts are in the expected ranges", () => {
  const world = buildWorld({ now: NOW });
  const { people, kinds } = summarize(world);
  assertEquals(people, {
    owner: 1,
    friend: 12,
    fof: 30,
    stranger: 8,
    muted: 1,
    hub: 1,
  });
  const notes = world.templates.filter((t) =>
    t.kind === 1 && !t.key.startsWith("history:")
  );
  assert(notes.length >= 230 && notes.length <= 290, `notes ${notes.length}`);
  assert(
    (kinds[7] ?? 0) >= 250 && (kinds[7] ?? 0) <= 350,
    `reactions ${kinds[7]}`,
  );
  assertEquals(kinds[6], 30);
  assertEquals(kinds[5], 3);
  assertEquals(kinds[30024], 1);
  assert(
    (kinds[1111] ?? 0) >= 12 && (kinds[1111] ?? 0) <= 18,
    `comments ${kinds[1111]}`,
  );
  const articles = world.templates.filter((t) => t.kind === 30023);
  assertEquals(new Set(articles.map((t) => t.tags[0][1])).size, 9);
  assert(
    articles.length === 10,
    "one article has an older and a newer version",
  );
  const tiers = tierOf(world);
  const authorTiers = articles.map((t) => tiers.get(t.author));
  // Ten versions: the owner has two articles, and one of them two versions.
  assertEquals(authorTiers.filter((t) => t === "owner").length, 3);
  assertEquals(authorTiers.filter((t) => t === "friend").length, 5);
  assertEquals(authorTiers.filter((t) => t === "fof").length, 2);
  const avatars = world.blobs.filter((b) => b.id.startsWith("avatar:")).length;
  assert(avatars >= 30 && avatars <= 40, `avatars ${avatars}`);
  assert(world.blobs.some((b) => b.id.startsWith("banner:")), "some banners");
  assert(
    world.blobs.filter((b) => b.id.startsWith("image:")).length >= 15,
    "about twenty illustrated notes",
  );
  const profiles = world.templates.filter((t) => t.kind === 0);
  assert(profiles.length >= 53, "every persona has a profile");
});

Deno.test("every blob hash matches its bytes and every placeholder names one", () => {
  const world = buildWorld({ now: NOW });
  const ids = new Set(world.blobs.map((b) => b.id));
  for (const blob of world.blobs) {
    const hex = createHash("sha256").update(blob.bytes).digest("hex");
    assertEquals(hex, blob.sha256, blob.id);
  }
  for (const t of world.templates) {
    const text = t.content + t.tags.flat().join("");
    for (const m of text.matchAll(/\{\{media:([^}]+)\}\}/g)) {
      assert(ids.has(m[1]), `${t.key} names ${m[1]}`);
    }
  }
});

Deno.test("references point at older events of the world", () => {
  const world = buildWorld({ now: NOW });
  const keys = byKey(world);
  for (const t of world.templates) {
    for (const ref of referencesOf(t)) {
      const target = keys.get(ref);
      assert(target, `${t.key} refers to ${ref}, which is not in the world`);
      assert(
        target.createdAt < t.createdAt,
        `${t.key} is not newer than ${ref}`,
      );
    }
  }
});

Deno.test("every note, reaction and repost is at or before now", () => {
  const world = buildWorld({ now: NOW });
  for (const t of world.templates) {
    assert(t.createdAt <= NOW, `${t.key} is in the future`);
  }
});

Deno.test("threads are two to five levels deep with NIP-10 markers", () => {
  const world = buildWorld({ now: NOW });
  const replies = world.templates.filter((t) => t.key.startsWith("reply:"));
  assert(replies.length >= 40, `replies ${replies.length}`);
  const roots = new Set(
    replies.map((t) => t.tags.find((tag) => tag[3] === "root")?.[1]),
  );
  assert(roots.size >= 20 && roots.size <= 30, `threads ${roots.size}`);
  for (const reply of replies) {
    const e = reply.tags.filter((tag) => tag[0] === "e");
    assert(e.some((tag) => tag[3] === "root"), `${reply.key} has a root`);
    if (e.length > 1) {
      assert(e.some((tag) => tag[3] === "reply"), `${reply.key} has a reply`);
    }
    assert(reply.tags.some((tag) => tag[0] === "p"), `${reply.key} names a p`);
  }
});

Deno.test("NIP-22 comments name their root and their parent", () => {
  const world = buildWorld({ now: NOW });
  const comments = world.templates.filter((t) => t.kind === 1111);
  for (const comment of comments) {
    const has = (name: string) => comment.tags.some((tag) => tag[0] === name);
    for (const name of ["A", "K", "P", "e", "k", "p"]) {
      assert(has(name), `${comment.key} has ${name}`);
    }
    const kTag = comment.tags.find((tag) => tag[0] === "K");
    assertEquals(kTag?.[1], "30023");
  }
  assert(
    comments.some((c) => c.tags.find((tag) => tag[0] === "k")?.[1] === "1111"),
    "one comment replies to a comment",
  );
});

Deno.test("reactions and reposts name their target and its author", () => {
  const world = buildWorld({ now: NOW });
  const keys = byKey(world);
  for (const t of world.templates.filter((x) => x.kind === 7 || x.kind === 6)) {
    const eTag = t.tags.find((tag) => tag[0] === "e");
    assert(eTag, `${t.key} has an e tag`);
    const target = keys.get(eTag[1].slice(8, -2));
    assert(target, `${t.key} targets a note`);
    const pTag = t.tags.find((tag) => tag[0] === "p");
    assertEquals(pTag?.[1], `{{pub:${target.author}}}`);
  }
});

Deno.test("the follow structure gives the intended hop distances", () => {
  const world = buildWorld({ now: NOW });
  const expected = distancesFrom("mara", world.follows, world.mutes);
  const tiers = tierOf(world);
  for (const persona of world.personas) {
    const want = {
      owner: 0,
      friend: 1,
      fof: 2,
      stranger: 3,
      muted: undefined,
      hub: undefined,
    }[persona.tier];
    assertEquals(expected.get(persona.handle), want, persona.handle);
    assert(tiers.has(persona.handle));
  }
});

Deno.test("distances computed from the signed kind 3 events match", () => {
  const world = buildWorld({ now: NOW });
  // Placeholders name personas by handle, so a list reads back as handles.
  const handleOf = (placeholder: string) => placeholder.slice(6, -2);
  const newest = new Map<string, Template>();
  for (const t of world.templates) {
    if (t.kind !== 3) continue;
    const current = newest.get(t.author);
    if (!current || t.createdAt > current.createdAt) newest.set(t.author, t);
  }
  const follows = new Map<string, string[]>();
  for (const [author, t] of newest) {
    follows.set(
      author,
      t.tags.filter((tag) => tag[0] === "p").map((tag) => handleOf(tag[1])),
    );
  }
  const mutes = new Map<string, string[]>();
  const muteList = world.templates.find((t) => t.kind === 10000);
  if (muteList) {
    mutes.set(muteList.author, muteList.tags.map((tag) => handleOf(tag[1])));
  }
  const distances = distancesFrom("mara", follows, mutes);
  const want: Record<string, number> = {
    owner: 0,
    friend: 1,
    fof: 2,
    stranger: 3,
  };
  for (const persona of world.personas) {
    if (persona.tier === "muted" || persona.tier === "hub") continue;
    assertEquals(
      distances.get(persona.handle),
      want[persona.tier],
      persona.handle,
    );
  }
});

Deno.test("the owner mutes someone a friend follows", () => {
  const world = buildWorld({ now: NOW });
  const [muted] = world.mutes.get("mara") ?? [];
  assert(muted !== undefined, "mara has a mute list");
  const friends = world.personas.filter((p) => p.tier === "friend").map((p) =>
    p.handle
  );
  const followers = friends.filter((f) =>
    world.follows.get(f)?.includes(muted)
  );
  assert(followers.length >= 1, "a friend follows the muted person");
});

Deno.test("one friend has an older and a newer follow list and profile", () => {
  const world = buildWorld({ now: NOW });
  const older = world.templates.find((t) => t.key === "follows:lucia.f:old");
  const newer = world.templates.find((t) => t.key === "follows:lucia.f");
  assert(older && newer && older.createdAt < newer.createdAt);
  const dropped = older.tags.map((t) => t[1]).filter((p) =>
    !newer.tags.some((t) => t[1] === p)
  );
  assertEquals(dropped.length, 1, "the newer list drops one person");
  const profileOld = world.templates.find((t) => t.key === "profile:sol:old");
  const profileNew = world.templates.find((t) => t.key === "profile:sol");
  assert(
    profileOld && profileNew && profileOld.createdAt < profileNew.createdAt,
  );
  assert(profileOld.profile?.name !== profileNew.profile?.name);
});

Deno.test("history notes are older than the default horizons", () => {
  const world = buildWorld({ now: NOW });
  const tiers = tierOf(world);
  const history = world.templates.filter((t) => t.key.startsWith("history:"));
  assert(history.length >= 10, "some history");
  for (const note of history) {
    const age = NOW - note.createdAt;
    if (tiers.get(note.author) === "friend") {
      assert(age > 120 * DAY && age < 201 * DAY, `${note.key} is ${age}s old`);
    } else {
      assert(age > 30 * DAY && age < 61 * DAY, `${note.key} is ${age}s old`);
    }
  }
});

Deno.test("ordinary notes fall in the three weeks before now", () => {
  const world = buildWorld({ now: NOW });
  for (const note of world.templates) {
    if (note.kind !== 1 || note.key.startsWith("history:")) continue;
    if (note.key.startsWith("reply:")) continue;
    assert(NOW - note.createdAt <= 21 * DAY, note.key);
  }
});

Deno.test("article bodies are real Markdown of 400 to 900 words", () => {
  const world = buildWorld({ now: NOW });
  for (const article of world.templates.filter((t) => t.kind === 30023)) {
    const words = article.content.split(/\s+/).filter(Boolean).length;
    assert(words >= 400 && words <= 900, `${article.key} has ${words} words`);
    assert(/^# /m.test(article.content), `${article.key} has a heading`);
    assert(/^## /m.test(article.content), `${article.key} has a section`);
  }
});

Deno.test("no two personas share a name", () => {
  const world = buildWorld({ now: NOW });
  const names = world.personas.map((p) => p.name);
  assertEquals(new Set(names).size, names.length);
});

Deno.test("profiles name their pictures only when a blob exists", () => {
  const world = buildWorld({ now: NOW });
  const ids = new Set(world.blobs.map((b) => b.id));
  for (const t of world.templates.filter((x) => x.kind === 0)) {
    for (const field of ["picture", "banner"] as const) {
      const value = t.profile?.[field];
      if (value !== undefined) assert(ids.has(value), `${t.key} ${field}`);
    }
  }
  assert(
    world.templates.filter((t) => t.kind === 0 && t.profile?.picture).length >=
      30,
    "about two thirds have a picture",
  );
});
