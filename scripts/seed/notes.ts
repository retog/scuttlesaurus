/**
 * The short notes of the seed world (kind 1), with their threads, reactions,
 * reposts and deletions, over the 21 days before `now`, plus a few older notes
 * that a default node must not fetch.
 *
 * Every event that refers to another refers to it by key, so ids are settled
 * when the event is rendered and each reference is older than its referrer.
 * @module
 */
import { BlobBook } from "./blobs.ts";
import type { Persona, Template, Tier } from "./model.ts";
import type { Rng } from "./random.ts";
import { illustrationSvg } from "./svg.ts";
import {
  CLOSERS,
  LINKS,
  OPENERS,
  REPLIES,
  TOPIC_BANK,
} from "./data/phrases.ts";

const DAY = 86400;
/** The newest note is at least this many seconds before `now`. */
const MIN_AGE = 1200;
/** No event is later than `now` minus this many seconds. */
const SAFETY = 60;
const REACTIONS = 300;
const REPOSTS = 30;
const DELETIONS = 3;
const IMAGES = 20;
const QUOTES = 4;
const THREADS = 25;

/** Notes per author, by tier: [least, most]. */
const NOTE_COUNTS: Readonly<Record<Tier, readonly [number, number]>> = {
  owner: [7, 7],
  friend: [5, 9],
  fof: [1, 4],
  stranger: [1, 2],
  muted: [1, 1],
  hub: [0, 0],
};

/** Reactors are drawn with these weights, by tier. */
const REACTOR_WEIGHT: Readonly<Record<Tier, number>> = {
  owner: 2,
  friend: 4,
  fof: 2,
  stranger: 1,
  muted: 0,
  hub: 0,
};

/** Reaction contents and their weights. */
const REACTION_CONTENT = ["+", "🦕", "❤️", "🔥"];
const REACTION_WEIGHTS = [60, 15, 10, 15];

/** What the notes are built from. */
export interface NotesInput {
  readonly personas: readonly Persona[];
  readonly now: number;
  readonly rng: Rng;
  readonly blobs: BlobBook;
}

/**
 * Builds the notes and everything that refers to them. Images are added to
 * `blobs`.
 */
export function buildNotes(input: NotesInput): Template[] {
  const { personas, now, rng, blobs } = input;
  const byHandle = new Map(personas.map((p) => [p.handle, p]));
  const topicOf = new Map<string, string>();
  const author = (handle: string): Persona => {
    const found = byHandle.get(handle);
    if (!found) throw new Error(`unknown persona ${handle}`);
    return found;
  };

  // Top-level notes.
  const top: Template[] = [];
  for (const persona of personas) {
    if (persona.topics.length === 0) continue;
    const [least, most] = NOTE_COUNTS[persona.tier];
    const count = rng.int(least, most);
    for (let i = 1; i <= count; i++) {
      const key = `note:${persona.handle}:${i}`;
      const topic = rng.pick(persona.topics);
      topicOf.set(key, topic);
      const mention = rng.chance(0.1)
        ? pickMention(rng, personas, persona.handle)
        : undefined;
      top.push({
        key,
        author: persona.handle,
        kind: 1,
        createdAt: now - pickAge(rng, now),
        tags: [],
        content: composeNote(rng, persona, topic, {
          long: rng.chance(0.03),
          mention,
          link: rng.chance(0.08),
          hashtag: rng.chance(0.3),
        }),
      });
    }
  }

  // Illustrations, on notes by people who are in range.
  const inRange = (t: Template) =>
    ["owner", "friend", "fof"].includes(author(t.author).tier);
  const imaged = new Set<string>();
  for (const note of rng.shuffle(top)) {
    if (imaged.size >= IMAGES) break;
    if (!inRange(note) || !rng.chance(0.14)) continue;
    const id = `image:${note.key}`;
    blobs.addSvg(id, note.author, illustrationSvg(rng.fork(id)));
    note.content += `\n{{media:${id}}}`;
    imaged.add(note.key);
  }

  // Quotes of older notes: a note that quotes one older note.
  const quoted = new Set<string>();
  let quotes = 0;
  for (const note of rng.sample(top, QUOTES * 3)) {
    if (quotes >= QUOTES) break;
    if (imaged.has(note.key) || quoted.has(note.key)) continue;
    const older = top.filter((t) =>
      t.author !== note.author &&
      t.createdAt <= note.createdAt - 3600 &&
      !imaged.has(t.key)
    );
    if (older.length === 0) continue;
    const target = rng.pick(older);
    note.content += `\n\nnostr:{{nevent:${target.key}}}`;
    quoted.add(target.key);
    quoted.add(note.key);
    quotes++;
  }

  // Threads: a root and a chain of replies, two to five levels deep.
  const threadRoots = rng.sample(
    top.filter((t) =>
      inRange(t) && !imaged.has(t.key) && !quoted.has(t.key) &&
      t.createdAt < now - 6 * 3600
    ),
    THREADS,
  );
  const replies: Template[] = [];
  const roots = new Set(threadRoots.map((t) => t.key));
  for (const root of threadRoots) {
    const topic = topicOf.get(root.key) ?? "gardening";
    let parent = root;
    const length = rng.int(1, 4);
    for (let level = 1; level <= length; level++) {
      const replier = pickReplier(rng, personas, [parent.author, root.author]);
      const createdAt = Math.min(
        parent.createdAt + rng.int(120, 4 * 3600),
        now - SAFETY,
      );
      if (createdAt <= parent.createdAt) break;
      const tags: string[][] = [
        ["e", `{{event:${root.key}}}`, "", "root"],
      ];
      if (parent !== root) {
        tags.push(["e", `{{event:${parent.key}}}`, "", "reply"]);
      }
      tags.push(["p", `{{pub:${parent.author}}}`]);
      if (root.author !== parent.author) {
        tags.push(["p", `{{pub:${root.author}}}`]);
      }
      const reply: Template = {
        key: `reply:${root.key}:${level}`,
        author: replier.handle,
        kind: 1,
        createdAt,
        tags,
        content: composeReply(rng, topic),
      };
      topicOf.set(reply.key, topic);
      replies.push(reply);
      parent = reply;
    }
  }

  // Older notes, outside the default horizons.
  const history: Template[] = [
    ...rng.sample(personas.filter((p) => p.tier === "friend"), 6).map(
      (persona, i) => olderNote(rng, persona, now, 120, 200, i),
    ),
    ...rng.sample(personas.filter((p) => p.tier === "fof"), 6).map(
      (persona, i) => olderNote(rng, persona, now, 30, 60, 10 + i),
    ),
  ];

  // Reactions: uneven popularity, with many notes having none.
  const pool = [...top, ...replies];
  const weights = pool.map(() => Math.pow(rng.next(), 3));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const reactions: Template[] = [];
  pool.forEach((note, i) => {
    const count = Math.round((REACTIONS * weights[i]) / total);
    for (const reactor of pickReactors(rng, personas, note.author, count)) {
      reactions.push({
        key: `react:${reactor.handle}:${note.key}`,
        author: reactor.handle,
        kind: 7,
        createdAt: Math.min(
          note.createdAt + rng.int(60, 36 * 3600),
          now - SAFETY,
        ),
        tags: [
          ["e", `{{event:${note.key}}}`],
          ["p", `{{pub:${note.author}}}`],
        ],
        content: rng.weighted(REACTION_CONTENT, REACTION_WEIGHTS),
      });
    }
  });

  // Reposts of popular-ish notes by people in range.
  const reposts: Template[] = [];
  const reposters = personas.filter((p) => ["friend", "fof"].includes(p.tier));
  const repostable = top.filter((t) => inRange(t) && !roots.has(t.key));
  for (const target of rng.sample(repostable, REPOSTS)) {
    const reposter = rng.pick(
      reposters.filter((p) => p.handle !== target.author),
    );
    reposts.push({
      key: `repost:${reposter.handle}:${target.key}`,
      author: reposter.handle,
      kind: 6,
      createdAt: Math.min(
        target.createdAt + rng.int(3600, 2 * DAY),
        now - SAFETY,
      ),
      tags: [
        ["e", `{{event:${target.key}}}`, ""],
        ["p", `{{pub:${target.author}}}`],
      ],
      content: `{{json:${target.key}}}`,
    });
  }

  // Deletions by the authors of plain notes.
  const deletions: Template[] = [];
  const deletable = top.filter((t) =>
    inRange(t) && !imaged.has(t.key) && !quoted.has(t.key) &&
    !roots.has(t.key) && t.createdAt < now - 12 * 3600
  );
  for (const target of rng.sample(deletable, DELETIONS)) {
    deletions.push({
      key: `delete:${target.key}`,
      author: target.author,
      kind: 5,
      createdAt: Math.min(
        target.createdAt + rng.int(3600, 10 * 3600),
        now - SAFETY,
      ),
      tags: [["e", `{{event:${target.key}}}`], ["k", "1"]],
      content: "",
    });
  }

  return [
    ...top,
    ...replies,
    ...history,
    ...reactions,
    ...reposts,
    ...deletions,
  ].map(withDerivedTags);
}

/** A note from long ago: `fromDays` to `toDays` before `now`. */
function olderNote(
  rng: Rng,
  persona: Persona,
  now: number,
  fromDays: number,
  toDays: number,
  index: number,
): Template {
  const topic = rng.pick(persona.topics);
  return {
    key: `history:${persona.handle}:${index}`,
    author: persona.handle,
    kind: 1,
    createdAt: now - rng.int(fromDays, toDays) * DAY - rng.int(0, DAY - 1),
    tags: [],
    content: composeNote(rng, persona, topic, { long: false, hashtag: false }),
  };
}

/**
 * Adds the tags that the content implies: `p` for each `npub`, `q` for each
 * quoted note, `t` for each hashtag. Existing tags are kept.
 */
export function withDerivedTags(template: Template): Template {
  const tags = template.tags.map((tag) => [...tag]);
  const seen = new Set(tags.map((tag) => JSON.stringify(tag)));
  const add = (tag: string[]) => {
    const json = JSON.stringify(tag);
    if (seen.has(json)) return;
    seen.add(json);
    tags.push(tag);
  };
  const { content } = template;
  for (const m of content.matchAll(/\{\{npub:([^}]+)\}\}/g)) {
    add(["p", `{{pub:${m[1]}}}`]);
  }
  for (const m of content.matchAll(/\{\{nevent:([^}]+)\}\}/g)) {
    add(["q", `{{event:${m[1]}}}`]);
  }
  for (const m of content.matchAll(/(?:^|\s)#([a-z][a-z0-9]{2,})/gi)) {
    add(["t", m[1].toLowerCase()]);
  }
  return { ...template, tags };
}

/** An age in seconds, between `MIN_AGE` and three weeks, skewed to daytime. */
function pickAge(rng: Rng, now: number): number {
  const span = 21 * DAY - MIN_AGE;
  let age = MIN_AGE;
  for (let attempt = 0; attempt < 8; attempt++) {
    age = MIN_AGE + Math.floor(Math.pow(rng.next(), 1.2) * span);
    const hour = new Date((now - age) * 1000).getUTCHours();
    if (hour >= 7 || rng.chance(0.25)) break;
  }
  return age;
}

/** A top-level note: one to three sentences, or several paragraphs if long. */
function composeNote(
  rng: Rng,
  persona: Persona,
  topic: string,
  options: {
    long: boolean;
    mention?: string;
    link?: boolean;
    hashtag?: boolean;
  },
): string {
  const bank = TOPIC_BANK[topic];
  if (!bank) throw new Error(`no phrases for topic ${topic}`);
  const paragraphs = options.long ? 3 : rng.chance(0.25) ? 2 : 1;
  const parts: string[] = [];
  for (let p = 0; p < paragraphs; p++) {
    const sentences = rng.sample(bank, options.long ? 2 : rng.int(1, 2));
    if (p === 0 && rng.chance(0.35)) sentences.unshift(rng.pick(OPENERS));
    if (p === paragraphs - 1 && rng.chance(0.3)) {
      sentences.push(rng.pick(CLOSERS[persona.voice]));
    }
    parts.push(sentences.join(" "));
  }
  let text = parts.join("\n\n");
  if (options.mention) {
    text = `Thanks nostr:{{npub:${options.mention}}} for the pointer. ${text}`;
  }
  if (options.link) text += `\n${rng.pick(LINKS)}`;
  if (options.hashtag) text += ` #${topic}`;
  return text;
}

/** A reply: a generic one, or a sentence on the topic of the thread. */
function composeReply(rng: Rng, topic: string): string {
  if (rng.chance(0.6)) return rng.pick(REPLIES);
  return rng.pick(TOPIC_BANK[topic] ?? REPLIES);
}

function pickMention(
  rng: Rng,
  personas: readonly Persona[],
  except: string,
): string {
  const candidates = personas.filter((p) =>
    ["friend", "fof"].includes(p.tier) && p.handle !== except
  );
  return rng.pick(candidates).handle;
}

/** Who replies: friends most, then friends of friends, strangers rarely. */
const REPLIER_WEIGHT: Readonly<Record<Tier, number>> = {
  owner: 1,
  friend: 3,
  fof: 2,
  stranger: 1,
  muted: 0,
  hub: 0,
};

function pickReplier(
  rng: Rng,
  personas: readonly Persona[],
  exclude: readonly string[],
): Persona {
  const candidates = personas.filter((p) =>
    REPLIER_WEIGHT[p.tier] > 0 && !exclude.includes(p.handle)
  );
  return rng.weighted(
    candidates,
    candidates.map((p) => REPLIER_WEIGHT[p.tier]),
  );
}

function pickReactors(
  rng: Rng,
  personas: readonly Persona[],
  author: string,
  count: number,
): Persona[] {
  const candidates = personas.filter((p) =>
    p.handle !== author && REACTOR_WEIGHT[p.tier] > 0
  );
  const weights = candidates.map((p) => REACTOR_WEIGHT[p.tier]);
  const chosen = new Map<string, Persona>();
  for (
    let attempt = 0;
    chosen.size < count && attempt < count * 10;
    attempt++
  ) {
    const picked = rng.weighted(candidates, weights);
    chosen.set(picked.handle, picked);
  }
  return [...chosen.values()];
}
