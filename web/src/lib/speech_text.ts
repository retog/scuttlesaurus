/**
 * Text for reading aloud: turns note content and article Markdown into plain
 * sentences a speech synthesizer can say, and cuts them into short chunks.
 *
 * Browsers stop or stall on long utterances (Chrome after about fifteen
 * seconds), so the player speaks one chunk at a time. Pure functions, no DOM.
 *
 * @module
 */
import { Marked, type Token as MdToken, type Tokens } from "marked";
import { type Token, tokenize } from "./nostr.ts";

/** Resolves a hex pubkey to the name to say. */
export type NameOf = (pubkey: string) => string;

/** Longest chunk handed to the synthesizer, in characters. */
export const MAX_CHUNK = 220;

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** What to say for one token of note content. */
function speakToken(token: Token, nameOf: NameOf): string {
  switch (token.type) {
    case "text":
      return token.text;
    case "newline":
      return "\n";
    case "url": {
      const h = host(token.url);
      return h ? `(link to ${h})` : "(link)";
    }
    case "image":
      return "(image)";
    case "video":
      return "(video)";
    case "profile":
      return nameOf(token.pubkey);
    case "event":
      return "(quoted note)";
    case "article":
      return "(linked article)";
    case "hashtag":
      return `hashtag ${token.tag}`;
  }
}

/**
 * The content of a note as text to speak: links become "(link to host)",
 * media "(image)" or "(video)", mentions the name of the person, quotes
 * "(quoted note)". Line breaks are kept.
 */
export function noteSpeechText(content: string, nameOf: NameOf): string {
  return tidy(tokenize(content).map((t) => speakToken(t, nameOf)).join(""));
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, name: string) => {
      const known = ENTITIES[name.toLowerCase()];
      if (known !== undefined) return known;
      if (name[0] !== "#") return whole;
      const code = name[1] === "x" || name[1] === "X"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    },
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/** Ends a heading or list item with a full stop so that the voice pauses. */
function closed(text: string): string {
  const t = text.trim();
  if (!t) return "";
  return /[.!?:;…]["'”’)]*$/.test(t) ? t : t + ".";
}

function inline(tokens: MdToken[] | undefined): string {
  if (!tokens) return "";
  return tokens.map((token) => {
    switch (token.type) {
      case "text":
        return "tokens" in token && token.tokens
          ? inline(token.tokens)
          : decodeEntities((token as Tokens.Text).text);
      case "strong":
      case "em":
      case "del":
        return inline((token as Tokens.Strong).tokens);
      case "link": {
        const link = token as Tokens.Link;
        const label = inline(link.tokens);
        // A bare URL as its own label is said like a link in a note.
        return label.trim() === link.href.trim() ? link.href : label;
      }
      case "image": {
        const alt = (token as Tokens.Image).text?.trim();
        return alt ? ` (image: ${decodeEntities(alt)}) ` : " (image) ";
      }
      case "codespan":
        return decodeEntities((token as Tokens.Codespan).text);
      case "br":
        return "\n";
      case "escape":
        return (token as Tokens.Escape).text;
      case "html":
        return decodeEntities(stripTags((token as Tokens.HTML).text));
      default:
        return "raw" in token ? String(token.raw) : "";
    }
  }).join("");
}

function blocks(tokens: MdToken[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        out.push(closed(inline((token as Tokens.Heading).tokens)));
        break;
      case "paragraph":
        out.push(inline((token as Tokens.Paragraph).tokens));
        break;
      case "text":
        out.push(inline([token]));
        break;
      case "blockquote":
        out.push(...blocks((token as Tokens.Blockquote).tokens));
        break;
      case "list":
        for (const item of (token as Tokens.List).items) {
          out.push(...blocks(item.tokens).map(closed));
        }
        break;
      case "code":
        out.push("(code example)");
        break;
      case "table": {
        const table = token as Tokens.Table;
        const row = (cells: Tokens.TableCell[]) =>
          closed(cells.map((c) => inline(c.tokens)).join(", "));
        out.push(row(table.header));
        for (const r of table.rows) out.push(row(r));
        break;
      }
      case "html":
        out.push(decodeEntities(stripTags((token as Tokens.HTML).text)));
        break;
      default:
        // space, hr, def: nothing to say
        break;
    }
  }
  return out.filter((p) => p.trim() !== "");
}

const lexer = new Marked({ gfm: true, breaks: false });

/**
 * The body of an article as paragraphs to speak. Markup is dropped, headings
 * and list items end with a full stop, code blocks are announced instead of
 * read, and links, media and `nostr:` references are said as in a note.
 */
export function markdownSpeechText(
  markdown: string,
  nameOf: NameOf,
): string[] {
  return blocks(lexer.lexer(markdown))
    .map((p) => noteSpeechText(p, nameOf))
    .filter((p) => p !== "");
}

/** Collapses runs of blanks and drops blank lines at the ends. */
function tidy(text: string): string {
  return text
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\(\s*\)/g, "")
    .trim();
}

/** Cuts `piece` at the last blank before `max`, or hard at `max`. */
function hardSplit(piece: string, max: number): string[] {
  const out: string[] = [];
  let rest = piece.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// Text up to a full stop, question or exclamation mark that ends a sentence
// (one followed by a blank, a closing quote or the end), then that mark.
const SENTENCE = /(?:[^.!?…]|[.!?…](?![\s"'”’)\]]|$))+(?:[.!?…]+["'”’)\]]*)?/g;
const CLAUSE = /[^,;:–—]*(?:[,;:–—]+(?=\s)|$)/g;

/**
 * Splits text into chunks of at most `max` characters: whole sentences where
 * they fit (several short ones are joined), else clauses, else words.
 * Line breaks always end a chunk.
 */
export function chunkText(text: string, max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  for (const line of text.split(/\n+/)) {
    const sentences = (line.match(SENTENCE) ?? [])
      .map((s) => s.trim())
      .filter(Boolean);
    let current = "";
    const push = () => {
      if (current) chunks.push(current);
      current = "";
    };
    for (const sentence of sentences) {
      const pieces = sentence.length <= max ? [sentence] : (
        (sentence.match(CLAUSE) ?? []).map((c) => c.trim()).filter(Boolean)
          .flatMap((c) => c.length <= max ? [c] : hardSplit(c, max))
      );
      for (const piece of pieces) {
        if (!current) current = piece;
        else if (current.length + 1 + piece.length <= max) {
          current += " " + piece;
        } else {
          push();
          current = piece;
        }
      }
      // A sentence that needed splitting is not joined with the next one.
      if (pieces.length > 1) push();
    }
    push();
  }
  return chunks;
}
