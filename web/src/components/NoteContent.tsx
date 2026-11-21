/**
 * Renders the content of a note: text with links, inline media, mentions
 * resolved to names, and hashtags linking to search.
 *
 * @module
 */
import {
  articlePath,
  notePath,
  profilePath,
  type Token,
  tokenize,
} from "../lib/nostr.ts";
import { displayNameOf, useProfile } from "../lib/profiles.ts";
import { Link } from "../lib/router.tsx";

function Mention({ pubkey }: { pubkey: string }) {
  const profile = useProfile(pubkey);
  return (
    <Link class="mention" to={profilePath(pubkey)}>
      @{displayNameOf(profile, pubkey)}
    </Link>
  );
}

function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  return bare.length > 44 ? bare.slice(0, 41) + "…" : bare;
}

type Segment =
  | { kind: "inline"; tokens: Token[] }
  | { kind: "media"; tokens: Extract<Token, { type: "image" | "video" }>[] };

function segments(tokens: Token[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const media = token.type === "image" || token.type === "video";
    if (token.type === "newline") {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const touchesMedia = [prev, next].some((t) =>
        t?.type === "image" || t?.type === "video"
      );
      if (touchesMedia || prev === undefined || next === undefined) continue;
    }
    const last = out[out.length - 1];
    if (media) {
      if (last?.kind === "media") last.tokens.push(token);
      else out.push({ kind: "media", tokens: [token] });
    } else if (last?.kind === "inline") last.tokens.push(token);
    else out.push({ kind: "inline", tokens: [token] });
  }
  return out;
}

function Inline({ token }: { token: Token }) {
  switch (token.type) {
    case "text":
      return <>{token.text}</>;
    case "newline":
      return <br />;
    case "url":
      return (
        <a href={token.url} target="_blank" rel="noopener noreferrer nofollow">
          {shortUrl(token.url)}
        </a>
      );
    case "profile":
      return <Mention pubkey={token.pubkey} />;
    case "event":
      return (
        <Link
          class="mention mention--ref"
          to={notePath(token.id, token.author)}
        >
          note {token.raw.slice(6, 14)}…
        </Link>
      );
    case "article":
      return (
        <Link class="mention mention--ref" to={articlePath(token.naddr)}>
          article “{token.identifier.slice(0, 24)}”
        </Link>
      );
    case "hashtag":
      return (
        <Link
          class="hashtag"
          to={`/search?q=${encodeURIComponent("#" + token.tag)}`}
        >
          #{token.tag}
        </Link>
      );
    default:
      return null;
  }
}

/** Props of {@link NoteContent}. */
export interface NoteContentProps {
  content: string;
  /** Hide media (used by compact cards). */
  noMedia?: boolean;
}

/** Note text with links, media, mentions and hashtags. */
export function NoteContent({ content, noMedia }: NoteContentProps) {
  const parts = segments(tokenize(content));
  return (
    <div class="note-content">
      {parts.map((part, i) =>
        part.kind === "inline"
          ? (
            <p class="note-content__text" key={i}>
              {part.tokens.map((t, j) => <Inline token={t} key={j} />)}
            </p>
          )
          : noMedia
          ? (
            <p class="note-content__text" key={i}>
              {part.tokens.map((t, j) => (
                <a
                  class="mention mention--ref"
                  href={t.url}
                  key={j}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t.type === "image" ? "image" : "video"}
                </a>
              ))}
            </p>
          )
          : (
            <div
              class={`note-media note-media--${
                Math.min(part.tokens.length, 4)
              }`}
              key={i}
            >
              {part.tokens.map((t, j) =>
                t.type === "image"
                  ? (
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      key={j}
                    >
                      <img src={t.url} alt="" loading="lazy" decoding="async" />
                    </a>
                  )
                  : (
                    <video
                      key={j}
                      src={t.url}
                      controls
                      preload="metadata"
                      playsInline
                    />
                  )
              )}
            </div>
          )
      )}
    </div>
  );
}
