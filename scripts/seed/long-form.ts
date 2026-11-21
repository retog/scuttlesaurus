/**
 * The long-form side of the seed world: articles (kind 30023) with their cover
 * and inline illustrations, a newer revision of one of them, the owner's draft
 * (kind 30024) and comments on the articles (kind 1111, NIP-22).
 * @module
 */
import { type ArticleData, ARTICLES, DRAFT } from "./data/articles.ts";
import { REPLIES, TOPIC_BANK } from "./data/phrases.ts";
import { BlobBook } from "./blobs.ts";
import type { Persona, Template } from "./model.ts";
import type { Rng } from "./random.ts";
import { illustrationSvg } from "./svg.ts";

const DAY = 86400;
const SAFETY = 60;
const INLINE_MARKER = "{{INLINE}}";

/** What the long-form builder needs. */
export interface LongFormInput {
  readonly personas: readonly Persona[];
  readonly now: number;
  readonly rng: Rng;
  readonly blobs: BlobBook;
}

/** Articles, their revisions, the draft and the comments. */
export function buildLongForm(input: LongFormInput): Template[] {
  const { personas, now, rng, blobs } = input;
  const out: Template[] = [];
  const latest = new Map<string, { key: string; createdAt: number }>();

  for (const article of ARTICLES) {
    const createdAt = now - article.days * DAY - rng.int(0, 8 * 3600);
    const body = withInline(article, blobs, rng);
    const tags = articleTags(article, createdAt, blobs, rng);
    out.push({
      key: `article:${article.slug}:1`,
      author: article.author,
      kind: 30023,
      createdAt,
      tags,
      content: body,
    });
    latest.set(article.slug, {
      key: `article:${article.slug}:1`,
      createdAt,
    });

    if (article.revision) {
      const revisedAt = now - article.revision.days * DAY - rng.int(0, 3600);
      out.push({
        key: `article:${article.slug}:2`,
        author: article.author,
        kind: 30023,
        createdAt: revisedAt,
        tags: [...tags],
        content: applyEdits(body, article.revision.edits, article.slug),
      });
      latest.set(article.slug, {
        key: `article:${article.slug}:2`,
        createdAt: revisedAt,
      });
    }
  }

  out.push({
    key: `draft:${DRAFT.slug}`,
    author: DRAFT.author,
    kind: 30024,
    createdAt: now - DAY - rng.int(0, 3600),
    tags: [
      ["d", DRAFT.slug],
      ["title", DRAFT.title],
      ["summary", DRAFT.summary],
    ],
    content: DRAFT.body,
  });

  out.push(...buildComments({ personas, now, rng, latest }));
  return out;
}

/** The tags of an article: address, title, summary, cover, date and topics. */
function articleTags(
  article: ArticleData,
  createdAt: number,
  blobs: BlobBook,
  rng: Rng,
): string[][] {
  const tags: string[][] = [
    ["d", article.slug],
    ["title", article.title],
    ["summary", article.summary],
  ];
  if (article.cover) {
    const id = `cover:${article.slug}`;
    blobs.addSvg(id, article.author, illustrationSvg(rng.fork(id)));
    tags.push(["image", `{{media:${id}}}`]);
  }
  tags.push(["published_at", String(createdAt)]);
  for (const topic of article.tags) tags.push(["t", topic]);
  return tags;
}

/**
 * The body with its marker replaced by an illustration line, or removed when
 * the article has no inline image.
 */
function withInline(article: ArticleData, blobs: BlobBook, rng: Rng): string {
  if (article.inline === undefined) {
    return article.body.split("\n").filter((line) => line !== INLINE_MARKER)
      .join("\n");
  }
  const id = `inline:${article.slug}`;
  blobs.addSvg(id, article.author, illustrationSvg(rng.fork(id)));
  return article.body.replace(
    INLINE_MARKER,
    `![${article.inline}]({{media:${id}}})`,
  );
}

/** Applies revision edits, each of which must occur exactly once. */
function applyEdits(
  body: string,
  edits: readonly (readonly [string, string])[],
  slug: string,
): string {
  let text = body;
  for (const [from, to] of edits) {
    const count = text.split(from).length - 1;
    if (count !== 1) {
      throw new Error(`revision edit of ${slug} matches ${count} times`);
    }
    text = text.replace(from, to);
  }
  return text;
}

/** Comments on the latest version of each article, with one reply. */
function buildComments(input: {
  personas: readonly Persona[];
  now: number;
  rng: Rng;
  latest: ReadonlyMap<string, { key: string; createdAt: number }>;
}): Template[] {
  const { personas, now, rng, latest } = input;
  const commenters = personas.filter((p) =>
    ["friend", "fof", "stranger"].includes(p.tier)
  );
  const out: Template[] = [];
  const topLevel: Template[] = [];
  let index = 0;

  ARTICLES.forEach((article, i) => {
    const target = latest.get(article.slug);
    if (!target) throw new Error(`no version of ${article.slug}`);
    const coordinate = `30023:{{pub:${article.author}}}:${article.slug}`;
    const count = i % 2 === 0 ? 2 : 1;
    for (let c = 0; c < count; c++) {
      const commenter = rng.pick(
        commenters.filter((p) => p.handle !== article.author),
      );
      index++;
      const comment: Template = {
        key: `comment:${article.slug}:${index}`,
        author: commenter.handle,
        kind: 1111,
        createdAt: Math.min(
          target.createdAt + rng.int(3600, 5 * DAY),
          now - SAFETY,
        ),
        tags: [
          ["A", coordinate],
          ["K", "30023"],
          ["P", `{{pub:${article.author}}}`],
          ["E", `{{event:${target.key}}}`],
          ["a", coordinate],
          ["e", `{{event:${target.key}}}`],
          ["k", "30023"],
          ["p", `{{pub:${article.author}}}`],
        ],
        content: commentText(rng, article.topic),
      };
      out.push(comment);
      topLevel.push(comment);
    }
  });

  // One reply to an older top-level comment.
  const parent = topLevel.find((c) => c.createdAt < now - 3 * DAY);
  if (parent !== undefined) {
    const replier = rng.pick(
      commenters.filter((p) => p.handle !== parent.author),
    );
    const articleSlug = parent.key.split(":")[1];
    const article = ARTICLES.find((a) => a.slug === articleSlug);
    const root = latest.get(articleSlug);
    if (article && root) {
      out.push({
        key: `comment:${articleSlug}:reply`,
        author: replier.handle,
        kind: 1111,
        createdAt: Math.min(parent.createdAt + 2 * 3600, now - SAFETY),
        tags: [
          ["A", `30023:{{pub:${article.author}}}:${articleSlug}`],
          ["K", "30023"],
          ["P", `{{pub:${article.author}}}`],
          ["E", `{{event:${root.key}}}`],
          ["e", `{{event:${parent.key}}}`],
          ["k", "1111"],
          ["p", `{{pub:${parent.author}}}`],
        ],
        content: commentText(rng, article.topic),
      });
    }
  }
  return out;
}

function commentText(rng: Rng, topic: string): string {
  return rng.chance(0.5)
    ? rng.pick(TOPIC_BANK[topic] ?? REPLIES)
    : rng.pick(REPLIES);
}
