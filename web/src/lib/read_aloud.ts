/**
 * What the read-aloud player says for notes and articles, and the sources
 * that feed it page after page from the same loaders the lists use.
 *
 * @module
 */
import { type ArticleRow, bodyWithoutTitle, fetchArticle } from "./articles.ts";
import type { NoteRow } from "./feed.ts";
import { articlePath, notePath, tokenize } from "./nostr.ts";
import { displayNameOf, loadProfile, prefetchProfile } from "./profiles.ts";
import type { SpeechItem, SpeechSource } from "./speech.ts";
import {
  markdownSpeechText,
  type NameOf,
  noteSpeechText,
} from "./speech_text.ts";

/** Loads the profiles of `pubkeys` (in one batch) and returns a name lookup. */
async function namesFor(pubkeys: Iterable<string>): Promise<NameOf> {
  const unique = [...new Set(pubkeys)];
  for (const pubkey of unique) prefetchProfile(pubkey);
  const profiles = await Promise.all(unique.map((pk) => loadProfile(pk)));
  const names = new Map(
    profiles.map((p) => [p.pubkey, displayNameOf(p, p.pubkey)]),
  );
  return (pubkey) => names.get(pubkey) ?? displayNameOf(undefined, pubkey);
}

function mentioned(content: string): string[] {
  return tokenize(content).flatMap((t) =>
    t.type === "profile" ? [t.pubkey] : []
  );
}

/** The NIP-32 ISO-639-1 language label of an event, if it has one. */
function languageOf(tags: string[][] | undefined): string | undefined {
  const label = tags?.find((t) =>
    t[0] === "l" && t[2] === "ISO-639-1" && /^[a-z]{2}$/i.test(t[1] ?? "")
  );
  return label?.[1].toLowerCase();
}

/** The pubkeys {@link noteItem} needs names for. */
function notePeople(note: NoteRow): string[] {
  return [
    note.pubkey,
    ...(note.repostedBy ? [note.repostedBy.pubkey] : []),
    ...mentioned(note.content),
  ];
}

/** The speech of a note: "Alice wrote: …", "Bob reposted Alice: …". */
export function noteItem(note: NoteRow, nameOf: NameOf): SpeechItem {
  const author = nameOf(note.pubkey);
  const intro = note.repostedBy
    ? `${nameOf(note.repostedBy.pubkey)} reposted ${author}:`
    : note.replyTo
    ? `${author} replied:`
    : `${author} wrote:`;
  const body = noteSpeechText(note.content, nameOf) || "(no text)";
  return {
    key: note.key,
    label: author,
    paragraphs: [intro, ...body.split("\n")],
    lang: languageOf(note.tags),
    path: notePath(note.id, note.pubkey),
  };
}

/** The speech of an article: title, standfirst, byline, then the body. */
export async function articleItem(
  article:
    & Pick<
      ArticleRow,
      "naddr" | "pubkey" | "title" | "summary"
    >
    & { content: string },
): Promise<SpeechItem> {
  const body = bodyWithoutTitle(article.content, article.title);
  const nameOf = await namesFor([article.pubkey, ...mentioned(body)]);
  return {
    key: article.naddr,
    label: article.title,
    paragraphs: [
      article.title,
      ...(article.summary ? [article.summary] : []),
      `By ${nameOf(article.pubkey)}.`,
      ...markdownSpeechText(body, nameOf),
    ],
    path: articlePath(article.naddr),
  };
}

/** How a source pages through a list. */
interface Paging<T> {
  load: (cursor?: number) => Promise<T[]>;
  cursorOf: (row: T) => number;
  keyOf: (row: T) => string;
  /** A page shorter than this ends the list. */
  pageSize: number;
  /** Rows to read before the first page (new posts), in order. */
  first?: readonly T[];
  /** Start at this row: the first page is loaded from its cursor. */
  start?: { key: string; cursor: number };
  /** Rows to skip (deleted). */
  skip?: (row: T) => boolean;
  /** Called with each new page before its rows are turned into items. */
  onPage?: (rows: T[]) => Promise<void>;
  toItem: (row: T) => Promise<SpeechItem | null>;
}

/** A source that reads rows one after the other, loading pages as needed. */
function pagedSource<T>(title: string, paging: Paging<T>): SpeechSource {
  const { load, cursorOf, keyOf, pageSize, skip, toItem, onPage } = paging;
  const seen = new Set<string>();
  let buffer: T[] = [];
  let cursor: number | undefined;
  let end = false;
  let started = false;

  const take = (rows: readonly T[]) =>
    rows.filter((row) => {
      const key = keyOf(row);
      if (seen.has(key) || skip?.(row)) return false;
      seen.add(key);
      return true;
    });

  const fill = async () => {
    if (!started) {
      started = true;
      const start = paging.start;
      const first = paging.first ?? [];
      const at = start ? first.findIndex((r) => keyOf(r) === start.key) : 0;
      if (!start || at >= 0) {
        buffer = take(first.slice(Math.max(at, 0)));
      } else {
        cursor = start.cursor;
        const page = await load(cursor);
        if (page.length < pageSize) end = true;
        if (page.length) cursor = cursorOf(page[page.length - 1]);
        const from = page.findIndex((r) => keyOf(r) === start.key);
        buffer = take(page.slice(Math.max(from, 0)));
        await onPage?.(buffer);
      }
      if (buffer.length) return;
    }
    while (!buffer.length && !end) {
      const page = await load(cursor);
      if (page.length < pageSize) end = true;
      if (page.length) cursor = cursorOf(page[page.length - 1]);
      const fresh = take(page);
      if (!fresh.length) end = true;
      await onPage?.(fresh);
      buffer = fresh;
    }
  };

  return {
    title,
    async next() {
      while (true) {
        if (!buffer.length) await fill();
        const row = buffer.shift();
        if (row === undefined) return null;
        const item = await toItem(row);
        if (item) return item;
      }
    },
  };
}

/** Options of {@link noteFeedSource}. */
export interface NoteFeedSourceOptions {
  load: (until?: number) => Promise<NoteRow[]>;
  pageSize?: number;
  prepend?: readonly NoteRow[];
  /** Start at this note rather than at the top. */
  start?: { key: string; at: number };
  hidden?: (note: NoteRow) => boolean;
}

/** Reads the notes of a feed, newest first, page after page. */
export function noteFeedSource(
  title: string,
  options: NoteFeedSourceOptions,
): SpeechSource {
  let nameOf: NameOf = (pk) => displayNameOf(undefined, pk);
  const resolve = async (rows: NoteRow[]) => {
    nameOf = await namesFor(rows.flatMap(notePeople));
  };
  return pagedSource<NoteRow>(title, {
    load: options.load,
    cursorOf: (n) => n.at,
    keyOf: (n) => n.key,
    pageSize: options.pageSize ?? 20,
    first: options.prepend,
    start: options.start
      ? { key: options.start.key, cursor: options.start.at }
      : undefined,
    skip: options.hidden,
    onPage: resolve,
    toItem: async (note) => {
      // Rows read before any page (new posts) need their names too.
      if (options.prepend?.includes(note)) await resolve([note]);
      return noteItem(note, nameOf);
    },
  });
}

/** Reads a list of articles one after the other, each in full. */
export function articleListSource(
  title: string,
  options: {
    load: (until: number | undefined, limit: number) => Promise<ArticleRow[]>;
    pageSize?: number;
  },
): SpeechSource {
  const pageSize = options.pageSize ?? 10;
  return pagedSource<ArticleRow>(title, {
    load: (until) => options.load(until, pageSize),
    cursorOf: (a) => a.publishedAt,
    keyOf: (a) => a.naddr,
    pageSize,
    toItem: async (row) => {
      // List rows may hold only an excerpt; read the current version in full.
      const full = await fetchArticle(row.naddr).catch(() => undefined);
      return full ? articleItem(full) : null;
    },
  });
}
