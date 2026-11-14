/**
 * Nostr helpers for the client: NIP-19 encoding and decoding, NIP-10 reply
 * tags, and the tokenizer that turns note content into renderable pieces.
 *
 * @module
 */
import * as nip19 from "@nostr/tools/nip19";
import type { Event } from "@nostr/tools/core";

/** A note as the UI handles it: a signed event without the signature. */
export type NoteEvent =
  & Pick<Event, "id" | "pubkey" | "created_at" | "content">
  & { kind?: number; tags?: string[][] };

const HEX64 = /^[0-9a-f]{64}$/;

/** Whether `value` is 64 lowercase hex characters. */
export function isHex64(value: string): boolean {
  return HEX64.test(value);
}

/** `npub1…` for a hex public key. */
export function toNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

/** `note1…` for a hex event id. */
export function toNote(id: string): string {
  return nip19.noteEncode(id);
}

/** `nevent1…` for an event, with optional author and relay hints. */
export function toNevent(
  id: string,
  extra: { author?: string; relays?: string[]; kind?: number } = {},
): string {
  return nip19.neventEncode({ id, ...extra });
}

/** `naddr1…` for an addressable event. */
export function toNaddr(
  kind: number,
  pubkey: string,
  identifier: string,
  relays?: string[],
): string {
  return nip19.naddrEncode({ kind, pubkey, identifier, relays });
}

/** What {@link decodeNip19} can return. */
export type Decoded =
  | { type: "npub"; pubkey: string }
  | { type: "nprofile"; pubkey: string; relays: string[] }
  | { type: "note"; id: string }
  | {
    type: "nevent";
    id: string;
    relays: string[];
    author?: string;
    kind?: number;
  }
  | {
    type: "naddr";
    kind: number;
    pubkey: string;
    identifier: string;
    relays: string[];
  }
  /** A bare 64-character hex string: a pubkey or an event id, unknown which. */
  | { type: "hex"; hex: string };

/**
 * Decode any of npub / nprofile / note / nevent / naddr (with or without the
 * `nostr:` prefix), or a bare hex string. Returns `null` when invalid.
 */
export function decodeNip19(input: string): Decoded | null {
  const value = input.trim().replace(/^nostr:/i, "");
  if (HEX64.test(value)) return { type: "hex", hex: value };
  try {
    const decoded = nip19.decode(value);
    switch (decoded.type) {
      case "npub":
        return { type: "npub", pubkey: decoded.data };
      case "nprofile":
        return {
          type: "nprofile",
          pubkey: decoded.data.pubkey,
          relays: decoded.data.relays ?? [],
        };
      case "note":
        return { type: "note", id: decoded.data };
      case "nevent":
        return {
          type: "nevent",
          id: decoded.data.id,
          relays: decoded.data.relays ?? [],
          author: decoded.data.author,
          kind: decoded.data.kind,
        };
      case "naddr":
        return {
          type: "naddr",
          kind: decoded.data.kind,
          pubkey: decoded.data.pubkey,
          identifier: decoded.data.identifier,
          relays: decoded.data.relays ?? [],
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Hex pubkey from an npub, nprofile or hex string; `null` otherwise. */
export function parsePubkey(input: string): string | null {
  const decoded = decodeNip19(input);
  if (!decoded) return null;
  if (decoded.type === "npub" || decoded.type === "nprofile") {
    return decoded.pubkey;
  }
  return decoded.type === "hex" ? decoded.hex : null;
}

/** Hex event id from a note, nevent or hex string; `null` otherwise. */
export function parseEventId(input: string): string | null {
  const decoded = decodeNip19(input);
  if (!decoded) return null;
  if (decoded.type === "note" || decoded.type === "nevent") return decoded.id;
  return decoded.type === "hex" ? decoded.hex : null;
}

/** "npub1abcd…wxyz" for display. */
export function shortNpub(pubkey: string): string {
  const npub = isHex64(pubkey) ? toNpub(pubkey) : pubkey;
  return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
}

/** Path of the in-app view for a pubkey. */
export function profilePath(pubkey: string): string {
  return `/p/${toNpub(pubkey)}`;
}

/** Path of the in-app view for an event id. */
export function notePath(id: string, author?: string): string {
  return `/n/${author ? toNevent(id, { author }) : toNote(id)}`;
}

/** Path of the in-app view for an article coordinate. */
export function articlePath(naddr: string): string {
  return `/a/${naddr}`;
}

/**
 * In-app path for a NIP-19 / NIP-21 reference, or `null` when it is not one:
 * npub/nprofile → profile, note/nevent → note, naddr → article.
 */
export function routeForNip19(input: string): string | null {
  const decoded = decodeNip19(input);
  if (!decoded) return null;
  switch (decoded.type) {
    case "npub":
    case "nprofile":
      return profilePath(decoded.pubkey);
    case "note":
      return notePath(decoded.id);
    case "nevent":
      return notePath(decoded.id, decoded.author);
    case "naddr":
      return articlePath(
        toNaddr(decoded.kind, decoded.pubkey, decoded.identifier),
      );
    default:
      return null;
  }
}

// --- NIP-10 reply tags --------------------------------------------------------

/**
 * Tags for a kind 1 reply to `parent` (NIP-10): a marked `root` `e` tag, a
 * marked `reply` `e` tag unless the parent is the root, and `p` tags for the
 * parent's author and everybody the parent mentions.
 */
export function replyTags(
  parent: Pick<NoteEvent, "id" | "pubkey"> & { tags?: string[][] },
): string[][] {
  const tags = parent.tags ?? [];
  const eTags = tags.filter((t) => t[0] === "e" && t[1]);
  const marked = eTags.find((t) => t[3] === "root");
  const root = marked ?? (eTags.find((t) => !t[3]) ?? undefined);
  const out: string[][] = [];
  if (root && root[1] !== parent.id) {
    out.push([
      "e",
      root[1],
      root[2] ?? "",
      "root",
      ...(root[4] ? [root[4]] : []),
    ]);
    out.push(["e", parent.id, "", "reply", parent.pubkey]);
  } else {
    out.push(["e", parent.id, "", "root", parent.pubkey]);
  }
  const people = new Set<string>([parent.pubkey]);
  for (const t of tags) {
    if (t[0] === "p" && isHex64(t[1] ?? "")) people.add(t[1]);
  }
  for (const pk of people) out.push(["p", pk]);
  return out;
}

/**
 * Tags implied by the content of a note: `p` for `nostr:npub`/`nprofile`
 * mentions, `q` for `nostr:note`/`nevent` quotes, `a` for `nostr:naddr`, and
 * `t` for hashtags. Existing tags in `have` are not repeated.
 */
export function contentTags(
  content: string,
  have: string[][] = [],
): string[][] {
  const seen = new Set(have.map((t) => `${t[0]}:${t[1]}`));
  const out: string[][] = [];
  const add = (tag: string[]) => {
    const key = `${tag[0]}:${tag[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  };
  for (const token of tokenize(content)) {
    if (token.type === "profile") add(["p", token.pubkey]);
    else if (token.type === "event") add(["q", token.id]);
    else if (token.type === "article") {
      add(["a", `${token.kind}:${token.pubkey}:${token.identifier}`]);
    } else if (token.type === "hashtag") add(["t", token.tag.toLowerCase()]);
  }
  return out;
}

// --- Content tokenizer ----------------------------------------------------------

/** A piece of note content. */
export type Token =
  | { type: "text"; text: string }
  | { type: "newline" }
  | { type: "url"; url: string }
  | { type: "image"; url: string }
  | { type: "video"; url: string }
  | { type: "profile"; pubkey: string; raw: string }
  | { type: "event"; id: string; author?: string; raw: string }
  | {
    type: "article";
    kind: number;
    pubkey: string;
    identifier: string;
    naddr: string;
    raw: string;
  }
  | { type: "hashtag"; tag: string };

const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const VIDEO = /\.(?:mp4|webm|mov|m4v|ogv)$/i;
const TOKEN = new RegExp(
  [
    "((?:https?:\\/\\/|data:image\\/)[^\\s<>]+)",
    "(nostr:[a-z0-9]+)",
    "(#[\\p{L}\\p{N}_]+)",
  ].join("|"),
  "giu",
);
const TRAILING = /[.,;:!?)\]}'"»”’]+$/;

function urlKind(url: string): "image" | "video" | "url" {
  if (url.startsWith("data:image/")) return "image";
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // keep the raw string
  }
  if (IMAGE.test(path)) return "image";
  if (VIDEO.test(path)) return "video";
  return "url";
}

/** Split note content into {@link Token}s. */
export function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  const pushText = (text: string) => {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) tokens.push({ type: "newline" });
      if (line) tokens.push({ type: "text", text: line });
    });
  };
  let last = 0;
  for (const match of content.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    let raw = match[0];
    if (match[3]) {
      const before = content[index - 1];
      if (before !== undefined && !/\s|[(\[{]/.test(before)) continue;
      if (/^#\d+$/.test(raw)) continue;
    }
    if (match[1]) {
      const trail = TRAILING.exec(raw)?.[0] ?? "";
      // keep a closing parenthesis that balances one inside the URL
      if (trail.startsWith(")") && raw.includes("(")) {
        raw = raw.slice(0, raw.length - trail.length + 1);
      } else raw = raw.slice(0, raw.length - trail.length);
    }
    let token: Token | null = null;
    if (match[1]) {
      token = { type: urlKind(raw), url: raw } as Token;
    } else if (match[2]) {
      const decoded = decodeNip19(raw);
      if (decoded?.type === "npub" || decoded?.type === "nprofile") {
        token = { type: "profile", pubkey: decoded.pubkey, raw };
      } else if (decoded?.type === "note") {
        token = { type: "event", id: decoded.id, raw };
      } else if (decoded?.type === "nevent") {
        token = { type: "event", id: decoded.id, author: decoded.author, raw };
      } else if (decoded?.type === "naddr") {
        token = {
          type: "article",
          kind: decoded.kind,
          pubkey: decoded.pubkey,
          identifier: decoded.identifier,
          naddr: toNaddr(decoded.kind, decoded.pubkey, decoded.identifier),
          raw,
        };
      }
    } else {
      token = { type: "hashtag", tag: raw.slice(1) };
    }
    if (!token) continue;
    if (index > last) pushText(content.slice(last, index));
    tokens.push(token);
    last = index + raw.length;
  }
  if (last < content.length) pushText(content.slice(last));
  return tokens;
}
