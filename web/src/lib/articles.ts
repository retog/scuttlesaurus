/**
 * Long-form articles (NIP-23) and their comments (NIP-22): SPARQL reads for
 * the lists, the reader, comment threads and reactions, the editor's loading
 * and saving, and every write (articles, drafts, comments, likes, deletions).
 *
 * An article is an address (`naddr`); each version is an event linked to it
 * by `nostr:address`. Reads always use the current version: no
 * `nostr:supersededBy`, no `nostr:deletedBy`.
 *
 * @module
 */
import type { Event } from "@nostr/tools/core";
import {
  addressFromIri,
  eventIdFromIri,
  pubkeyFromIri,
} from "../../../src/vocab.ts";
import { decodeNip19, isHex64, toNaddr } from "./nostr.ts";
import { fetchEvents } from "./relay.ts";
import {
  addressTerm,
  eventTerm,
  int,
  iriRef,
  notDeleted,
  notSuperseded,
  pubkeyTerm,
  type Row,
  select,
  str,
  values,
} from "./sparql.ts";
import { publish } from "./session.ts";

/** Kind of a published article (NIP-23). */
export const ARTICLE_KIND = 30023;
/** Kind of a draft article (NIP-23). */
export const DRAFT_KIND = 30024;
/** Kind of a comment (NIP-22). */
export const COMMENT_KIND = 1111;
/** Kind of a reaction (NIP-25). */
export const REACTION_KIND = 7;

/** An article or draft as lists and readers need it. */
export interface ArticleRow {
  /** `naddr1…` of the address, without relay hints. */
  naddr: string;
  /** 30023 for articles, 30024 for drafts. */
  kind: number;
  /** Hex pubkey of the author. */
  pubkey: string;
  /** The `d` tag. */
  identifier: string;
  /** Hex event id of this version. */
  versionId: string;
  title: string;
  summary?: string;
  /** Cover image URL. */
  image?: string;
  /** Unix seconds: `published_at`, or `created_at` when that is missing. */
  publishedAt: number;
  /** Unix seconds of this version. */
  createdAt: number;
  /** The `t` tags (topics), in order, without repeats. */
  tags: string[];
  /** Markdown body, when the query fetched it. */
  content?: string;
}

/** The body without a leading `# Title` line that repeats the article's title. */
export function bodyWithoutTitle(content: string, title: string): string {
  const match = /^#\s+(.+?)\s*(\r?\n|$)/.exec(content);
  if (!match || match[1].trim() !== title.trim()) return content;
  return content.slice(match[0].length).replace(/^\s+/, "");
}

/** The fields of an article that the reader and the editor need to address it. */
export interface ArticleRef {
  kind: number;
  pubkey: string;
  identifier: string;
  versionId: string;
}

/** The current version of an article, with the history facts the reader shows. */
export interface ArticleDetail extends ArticleRow {
  content: string;
  /** Number of versions of the address that are not retracted. */
  versionCount: number;
  /** Unix seconds of the first version. */
  firstPublishedAt: number;
}

/** A comment (kind 1111) on an article. */
export interface CommentRow {
  /** Hex event id. */
  id: string;
  /** Hex pubkey of the author. */
  pubkey: string;
  /** Unix seconds. */
  createdAt: number;
  content: string;
  /** Hex id of the event this comment replies to (the article version for top-level comments). */
  replyTo?: string;
}

/** One line of a comment thread: the comment, its depth, and who it answers when flattened. */
export interface ThreadItem {
  comment: CommentRow;
  /** 0 for top-level comments, 1 for every reply (deeper replies are flattened). */
  depth: 0 | 1;
  /** For a flattened reply: the author of the comment it answers. */
  replyingTo?: string;
}

/** Reactions to one version: how many people reacted, and the viewer's own reaction. */
export interface ReactionState {
  count: number;
  /** Hex id of the viewer's own reaction, to be deleted to unlike. */
  own?: string;
}

/** A version of an article as stored, with the full event fields for editing. */
export interface EditableDoc {
  kind: number;
  identifier: string;
  title: string;
  summary: string;
  image: string;
  topics: string[];
  content: string;
  /** Unix seconds, from `published_at`, when the event has it. */
  publishedAt?: number;
  createdAt: number;
  versionId: string;
}

/** Options of {@link fetchArticles}. */
export interface ArticleQuery {
  /** `following`: the viewer and the people the viewer follows. `network`: everybody replicated. */
  scope: "following" | "network";
  /** Hex pubkey of the signed-in person, or of the node's owner. */
  viewer?: string;
  /** Restrict to one author (hex pubkey). */
  author?: string;
  /** Restrict to one topic (`t` tag). */
  tag?: string;
  /** Only articles published before this unix time (for paging). */
  until?: number;
  limit: number;
}

const NOSTR_PREFIX = "nostr:";

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** The `t` values of a stored `tags` JSON array. */
function topicsOf(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const tags: unknown = JSON.parse(json);
    if (!Array.isArray(tags)) return [];
    const topics: string[] = [];
    for (const tag of tags as unknown[]) {
      if (Array.isArray(tag) && tag[0] === "t" && typeof tag[1] === "string") {
        topics.push(tag[1]);
      }
    }
    return unique(topics);
  } catch {
    return [];
  }
}

function articleRow(row: Row): ArticleRow | undefined {
  if (!row.version || !row.address || !row.author) return undefined;
  try {
    const { kind, pubkey, identifier } = addressFromIri(row.address);
    const createdAt = num(row.createdAt) ?? 0;
    return {
      naddr: row.address.slice(NOSTR_PREFIX.length),
      kind,
      pubkey,
      identifier,
      versionId: eventIdFromIri(row.version),
      title: row.title?.trim() || "Untitled",
      summary: row.summary || undefined,
      image: row.image || undefined,
      publishedAt: num(row.publishedAt) ?? createdAt,
      createdAt,
      tags: topicsOf(row.tagsJson),
      content: row.content,
    };
  } catch {
    return undefined;
  }
}

/** Hex pubkeys whose articles a `following` list shows, or `undefined` for everybody. */
async function authorsOf(query: ArticleQuery): Promise<string[] | undefined> {
  if (query.author) return isHex64(query.author) ? [query.author] : [];
  if (query.scope === "network") return undefined;
  if (!query.viewer || !isHex64(query.viewer)) return [];
  return await fetchFollowing(query.viewer);
}

/**
 * The viewer followed by the people on the viewer's current follow list (NIP-02).
 */
export async function fetchFollowing(viewer: string): Promise<string[]> {
  const rows = await select(`SELECT DISTINCT ?followed WHERE {
    ?list nostr:author ${
    pubkeyTerm(viewer)
  } ; nostr:kind 3 ; nostr:follows ?followed .
    ${notSuperseded("?list")}
  }`);
  const followed = rows.flatMap((row) => {
    if (!row.followed) return [];
    try {
      return [pubkeyFromIri(row.followed)];
    } catch {
      return [];
    }
  });
  return unique([viewer, ...followed]);
}

/**
 * The current versions of articles, newest first by `published_at` (falling
 * back to `created_at`). Restricted by author, topic and paging as asked.
 */
export async function fetchArticles(
  query: ArticleQuery,
): Promise<ArticleRow[]> {
  const authors = await authorsOf(query);
  if (authors && authors.length === 0) return [];
  const clauses: string[] = [];
  if (authors) clauses.push(values("author", authors.map(pubkeyTerm)));
  clauses.push(
    `?version nostr:kind ${ARTICLE_KIND} ; nostr:address ?address ; nostr:author ?author ; nostr:createdAt ?createdAt .`,
  );
  if (query.tag) clauses.push(`?version tag:t ${str(query.tag)} .`);
  clauses.push(
    notSuperseded("?version"),
    notDeleted("?version"),
    "OPTIONAL { ?version nostr:publishedAt ?publishedAt }",
    "BIND(COALESCE(?publishedAt, ?createdAt) AS ?sortAt)",
  );
  if (query.until !== undefined) {
    clauses.push(`FILTER(?sortAt < ${int(query.until)})`);
  }
  // The page is picked first, from the few columns it is sorted by; the text
  // fields (the whole article body among them) are fetched for those rows only.
  const keys = await select(
    `SELECT ?version ?address ?author ?createdAt ?publishedAt WHERE {
    ${clauses.join("\n    ")}
  }
  ORDER BY DESC(?sortAt)
  LIMIT ${int(query.limit)}`,
  );
  if (keys.length === 0) return [];
  const texts = await select(
    `SELECT ?version ?title ?summary ?image ?tagsJson ?content WHERE {
    ${values("version", keys.map((row) => iriRef(row.version!)))}
    OPTIONAL { ?version nostr:title ?title }
    OPTIONAL { ?version nostr:summary ?summary }
    OPTIONAL { ?version nostr:image ?image }
    OPTIONAL { ?version nostr:tags ?tagsJson }
    OPTIONAL { ?version nostr:content ?content }
  }`,
  );
  const textOf = new Map<string, Row>();
  for (const row of texts) {
    if (!textOf.has(row.version!)) textOf.set(row.version!, row);
  }
  return keys.flatMap((key) => {
    const parsed = articleRow({ ...textOf.get(key.version!), ...key });
    return parsed ? [parsed] : [];
  });
}

/**
 * The current version of one article, with its body and history facts.
 * Resolves to `undefined` for an unknown, retracted or non-article address.
 */
export async function fetchArticle(
  naddr: string,
): Promise<ArticleDetail | undefined> {
  const decoded = decodeNip19(naddr);
  if (decoded?.type !== "naddr" || decoded.kind !== ARTICLE_KIND) {
    return undefined;
  }
  const address = addressTerm(decoded.kind, decoded.pubkey, decoded.identifier);
  const versions = await select(
    `SELECT ?version ?createdAt ?publishedAt ?newer WHERE {
    ?version nostr:address ${address} ; nostr:kind ${ARTICLE_KIND} ; nostr:createdAt ?createdAt .
    ${notDeleted("?version")}
    OPTIONAL { ?version nostr:publishedAt ?publishedAt }
    OPTIONAL { ?version nostr:supersededBy ?newer }
  }`,
  );
  const seen = new Map<
    string,
    { createdAt: number; publishedAt: number; superseded: boolean }
  >();
  for (const row of versions) {
    if (!row.version) continue;
    const id = eventIdFromIri(row.version);
    const createdAt = num(row.createdAt) ?? 0;
    const entry = seen.get(id) ?? {
      createdAt,
      publishedAt: num(row.publishedAt) ?? createdAt,
      superseded: false,
    };
    if (row.newer) entry.superseded = true;
    seen.set(id, entry);
  }
  const current = [...seen.entries()]
    .filter(([, entry]) => !entry.superseded)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)[0];
  if (!current) return undefined;
  const [versionId, meta] = current;
  const [detail] = await select(
    `SELECT ?title ?summary ?image ?tagsJson ?content WHERE {
    ${values("version", [eventTerm(versionId)])}
    OPTIONAL { ?version nostr:title ?title }
    OPTIONAL { ?version nostr:summary ?summary }
    OPTIONAL { ?version nostr:image ?image }
    OPTIONAL { ?version nostr:tags ?tagsJson }
    OPTIONAL { ?version nostr:content ?content }
  }`,
  );
  if (!detail) return undefined;
  return {
    naddr: toNaddr(decoded.kind, decoded.pubkey, decoded.identifier),
    kind: ARTICLE_KIND,
    pubkey: decoded.pubkey,
    identifier: decoded.identifier,
    versionId,
    title: detail.title?.trim() || "Untitled",
    summary: detail.summary || undefined,
    image: detail.image || undefined,
    publishedAt: meta.publishedAt,
    createdAt: meta.createdAt,
    tags: topicsOf(detail.tagsJson),
    content: detail.content ?? "",
    versionCount: seen.size,
    firstPublishedAt: Math.min(
      ...[...seen.values()].map((entry) => entry.publishedAt),
    ),
  };
}

/** The most used topics (`t` tags) of current articles. */
export async function fetchTopTags(
  limit: number,
): Promise<{ tag: string; count: number }[]> {
  const rows = await select(
    `SELECT ?topic (COUNT(DISTINCT ?version) AS ?count) WHERE {
    ?version nostr:kind ${ARTICLE_KIND} ; tag:t ?topic .
    ${notSuperseded("?version")}
    ${notDeleted("?version")}
  }
  GROUP BY ?topic
  ORDER BY DESC(?count) ?topic
  LIMIT ${int(limit)}`,
  );
  return rows.flatMap((row) =>
    row.topic ? [{ tag: row.topic, count: num(row.count) ?? 0 }] : []
  );
}

/** The comments on an article (kind 1111 with the article as root), oldest first. */
export async function fetchComments(naddr: string): Promise<CommentRow[]> {
  const decoded = decodeNip19(naddr);
  if (decoded?.type !== "naddr") return [];
  const rows = await select(
    `SELECT ?comment ?author ?createdAt ?content ?replyTo WHERE {
    ?comment nostr:kind ${COMMENT_KIND} ;
             nostr:rootAddress ${
      addressTerm(decoded.kind, decoded.pubkey, decoded.identifier)
    } ;
             nostr:author ?author ;
             nostr:createdAt ?createdAt .
    ${notDeleted("?comment")}
    OPTIONAL { ?comment nostr:content ?content }
    OPTIONAL { ?comment nostr:replyTo ?replyTo }
  }
  ORDER BY ASC(?createdAt)
  LIMIT 1000`,
  );
  const byId = new Map<string, CommentRow>();
  for (const row of rows) {
    if (!row.comment || !row.author) continue;
    const id = eventIdFromIri(row.comment);
    const existing = byId.get(id);
    if (existing) {
      // A comment with several parents: keep the first one seen.
      if (!existing.replyTo && row.replyTo) {
        existing.replyTo = eventIdFromIri(row.replyTo);
      }
      continue;
    }
    byId.set(id, {
      id,
      pubkey: pubkeyFromIri(row.author),
      createdAt: num(row.createdAt) ?? 0,
      content: row.content ?? "",
      replyTo: row.replyTo ? eventIdFromIri(row.replyTo) : undefined,
    });
  }
  return [...byId.values()];
}

/**
 * Arrange comments as a thread: top-level comments in time order, each
 * followed by its replies. Replies to replies are listed after their
 * top-level comment at depth 1 with `replyingTo` set. A comment whose parent
 * is not among `comments` (the article version, or a deleted comment) is
 * top-level.
 */
export function threadComments(comments: readonly CommentRow[]): ThreadItem[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const children = new Map<string, CommentRow[]>();
  const roots: CommentRow[] = [];
  for (const comment of comments) {
    if (comment.replyTo && byId.has(comment.replyTo)) {
      const list = children.get(comment.replyTo) ?? [];
      list.push(comment);
      children.set(comment.replyTo, list);
    } else roots.push(comment);
  }
  const out: ThreadItem[] = [];
  const visited = new Set<string>();
  const walk = (comment: CommentRow, depth: 0 | 1, replyingTo?: string) => {
    if (visited.has(comment.id)) return;
    visited.add(comment.id);
    out.push({ comment, depth, replyingTo });
    for (const child of children.get(comment.id) ?? []) {
      walk(
        child,
        1,
        depth === 0 ? undefined : comment.pubkey,
      );
    }
  };
  for (const root of roots) walk(root, 0);
  return out;
}

/** Reactions (kind 7) to the given versions: counts and the viewer's own reactions. */
export async function fetchArticleReactions(
  versionIds: readonly string[],
  viewer?: string,
): Promise<Map<string, ReactionState>> {
  const result = new Map<string, ReactionState>();
  if (versionIds.length === 0) return result;
  const rows = await select(`SELECT ?reaction ?version ?author WHERE {
    ${values("version", versionIds.map(eventTerm))}
    ?reaction nostr:kind ${REACTION_KIND} ; nostr:reactsTo ?version ; nostr:author ?author .
    ${notDeleted("?reaction")}
  }`);
  const reactors = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.reaction || !row.version || !row.author) continue;
    const version = eventIdFromIri(row.version);
    const author = pubkeyFromIri(row.author);
    const state = result.get(version) ?? { count: 0 };
    const people = reactors.get(version) ?? new Set<string>();
    if (!people.has(author)) {
      people.add(author);
      state.count++;
    }
    reactors.set(version, people);
    if (viewer && author === viewer && !state.own) {
      state.own = eventIdFromIri(row.reaction);
    }
    result.set(version, state);
  }
  return result;
}

/** The current, undeleted drafts (kind 30024) of an author, newest first. */
export async function fetchDrafts(author: string): Promise<ArticleRow[]> {
  if (!isHex64(author)) return [];
  const rows = await select(
    `SELECT ?version ?address ?author ?createdAt ?title ?summary ?tagsJson WHERE {
    ?version nostr:kind ${DRAFT_KIND} ; nostr:address ?address ;
             nostr:author ${pubkeyTerm(author)} ; nostr:createdAt ?createdAt .
    ${notSuperseded("?version")}
    ${notDeleted("?version")}
    OPTIONAL { ?version nostr:title ?title }
    OPTIONAL { ?version nostr:summary ?summary }
    OPTIONAL { ?version nostr:tags ?tagsJson }
  }
  ORDER BY DESC(?createdAt)
  LIMIT 100`,
  );
  return rows.flatMap((row) => {
    const parsed = articleRow(row);
    return parsed ? [{ ...parsed, kind: DRAFT_KIND }] : [];
  });
}

/**
 * The events of one author with a given `d` value, as the relay serves them
 * (current versions only), for loading an article or draft into the editor.
 */
export async function fetchOwnVersions(
  identifier: string,
  author: string,
): Promise<EditableDoc[]> {
  const events = await fetchEvents([{
    kinds: [ARTICLE_KIND, DRAFT_KIND],
    authors: [author],
    "#d": [identifier],
  }]);
  return events.map(readEditable);
}

/** The editable fields of a stored article or draft event. */
export function readEditable(event: Event): EditableDoc {
  const first = (name: string): string =>
    event.tags.find((tag) => tag[0] === name)?.[1] ?? "";
  const published = Number(first("published_at"));
  return {
    kind: event.kind,
    identifier: first("d"),
    title: first("title"),
    summary: first("summary"),
    image: first("image"),
    topics: unique(
      event.tags.filter((tag) => tag[0] === "t" && tag[1]).map((tag) => tag[1]),
    ),
    content: event.content,
    publishedAt: Number.isFinite(published) && first("published_at") !== ""
      ? published
      : undefined,
    createdAt: event.created_at,
    versionId: event.id,
  };
}

// --- Writing ----------------------------------------------------------------------

/** What an article or draft consists of when written. */
export interface ArticleFields {
  identifier: string;
  title: string;
  summary?: string;
  image?: string;
  /** Topics; normalised and de-duplicated on the way out. */
  tags?: string[];
  content: string;
  /** Keep the original value when editing. Defaults to now. */
  publishedAt?: number;
  /**
   * The `created_at` of the version this one replaces, if any. The new event
   * is stamped at least one second later, so that it wins over that version.
   */
  after?: number;
}

/** Normalise a topic typed by the author: lower case, no `#`, no spaces. */
export function normalizeTopic(raw: string): string {
  return raw.trim().replace(/^#+/, "").toLowerCase().replace(/[\s,]+/g, "-")
    .slice(0, 48);
}

/** A URL-safe slug of a title plus a short random suffix, for a new `d` value. */
export function makeIdentifier(title: string): string {
  const slug = title.normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 48) || "article";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${slug}-${suffix}`;
}

function addressedTags(fields: ArticleFields): string[][] {
  const tags: string[][] = [["d", fields.identifier]];
  const title = fields.title.trim();
  const summary = fields.summary?.trim();
  const image = fields.image?.trim();
  if (title) tags.push(["title", title]);
  if (summary) tags.push(["summary", summary]);
  if (image) tags.push(["image", image]);
  if (fields.publishedAt !== undefined) {
    tags.push(["published_at", String(Math.floor(fields.publishedAt))]);
  }
  const topics = unique(
    (fields.tags ?? []).map(normalizeTopic).filter(Boolean),
  );
  for (const topic of topics) tags.push(["t", topic]);
  return tags;
}

function stamp(after?: number): number {
  return Math.max(Math.floor(Date.now() / 1000), (after ?? 0) + 1);
}

/** Publish an article (kind 30023, NIP-23). */
export function publishArticle(fields: ArticleFields): Promise<Event> {
  return publish({
    kind: ARTICLE_KIND,
    created_at: stamp(fields.after),
    content: fields.content,
    tags: addressedTags(fields),
  });
}

/** Save a draft (kind 30024, same tags as an article). */
export function saveDraft(fields: ArticleFields): Promise<Event> {
  return publish({
    kind: DRAFT_KIND,
    created_at: stamp(fields.after),
    content: fields.content,
    tags: addressedTags(fields),
  });
}

/** Retract an addressable event (NIP-09): every version up to now, and this version. */
export function deleteAddress(ref: ArticleRef): Promise<Event> {
  const tags: string[][] = [
    ["a", `${ref.kind}:${ref.pubkey}:${ref.identifier}`],
  ];
  if (isHex64(ref.versionId)) tags.push(["e", ref.versionId]);
  tags.push(["k", String(ref.kind)]);
  return publish({
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags,
  });
}

/** Retract one event by id (NIP-09), used for comments and reactions. */
export function deleteEvent(id: string, kind: number): Promise<Event> {
  return publish({
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [["e", id], ["k", String(kind)]],
  });
}

/**
 * Comment on an article (kind 1111, NIP-22). Without `parent` it is a
 * top-level comment; with `parent` it replies to that comment.
 */
export function commentOnArticle(
  article: ArticleRef,
  text: string,
  parent?: { id: string; pubkey: string },
): Promise<Event> {
  const coordinate = `${article.kind}:${article.pubkey}:${article.identifier}`;
  const tags: string[][] = [
    ["A", coordinate],
    ["K", String(article.kind)],
    ["P", article.pubkey],
  ];
  if (!parent) {
    tags.push(
      ["a", coordinate],
      ["e", article.versionId],
      ["k", String(article.kind)],
      ["p", article.pubkey],
    );
  } else {
    tags.push(
      ["e", parent.id],
      ["k", String(COMMENT_KIND)],
      ["p", parent.pubkey],
    );
  }
  return publish({
    kind: COMMENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: text,
    tags,
  });
}

/** Like an article's current version (kind 7, NIP-25). */
export function likeArticle(article: ArticleRef): Promise<Event> {
  return publish({
    kind: REACTION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: "+",
    tags: [
      ["e", article.versionId],
      ["a", `${article.kind}:${article.pubkey}:${article.identifier}`],
      ["p", article.pubkey],
      ["k", String(article.kind)],
    ],
  });
}

/** Take back a like, by deleting its reaction event (NIP-09). */
export function unlike(reactionId: string): Promise<Event> {
  return deleteEvent(reactionId, REACTION_KIND);
}

/** A sentence for the reader of an error from a write, in plain words. */
export function explainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("blocked:")) {
    return "This node only keeps writing from people in its social graph, and your key is outside it, so the node refused this.";
  }
  return message;
}
