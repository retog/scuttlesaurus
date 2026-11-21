/**
 * A note (kind 1) as a card.
 *
 * @module
 */
import type { ComponentChildren } from "preact";
import { Heart, MessageCircle, Repeat2 } from "lucide-preact";
import { formatCount } from "../lib/format.ts";
import { type NoteEvent, notePath } from "../lib/nostr.ts";
import { navigate } from "../lib/router.tsx";
import { Avatar } from "./Avatar.tsx";
import { AuthorName } from "./AuthorName.tsx";
import { IconButton } from "./Button.tsx";
import { NoteContent } from "./NoteContent.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { Link } from "../lib/router.tsx";

/** Props of {@link NoteCard}. */
export interface NoteCardProps {
  /** The note; `tags` are optional (only needed to build replies). */
  note: NoteEvent;
  /**
   * `default`: feed item, click opens the note. `compact`: smaller, three
   * lines, no actions (search results, quotes). `focused`: the subject of a
   * thread view, larger with the full date.
   */
  variant?: "default" | "compact" | "focused";
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  liked?: boolean;
  reposted?: boolean;
  onReply?: () => void;
  onRepost?: () => void;
  onLike?: () => void;
  /** Line above the header, e.g. "Replying to @ada" or "Reposted by …". */
  context?: ComponentChildren;
}

/** A note with avatar, author, time, content and action buttons. */
export function NoteCard(props: NoteCardProps) {
  const { note, variant = "default", context } = props;
  const href = notePath(note.id, note.pubkey);
  const showActions = variant !== "compact" &&
    (props.onReply || props.onRepost || props.onLike ||
      props.replyCount !== undefined || props.likeCount !== undefined ||
      props.repostCount !== undefined);

  const open = (event: MouseEvent) => {
    if (variant === "focused") return;
    const target = event.target as Element;
    if (target.closest("a, button, video, input, textarea")) return;
    if (globalThis.getSelection()?.toString()) return;
    navigate(href);
  };

  const count = (n?: number) =>
    n === undefined ? undefined : n > 0 ? formatCount(n) : "";

  return (
    <article
      class={`card note-card note-card--${variant}`}
      onClick={open}
      data-note-id={note.id}
    >
      {context && <div class="note-card__context">{context}</div>}
      <div class="note-card__layout">
        <Avatar pubkey={note.pubkey} size={variant === "compact" ? 32 : 44} />
        <div class="note-card__main">
          <header class="note-card__header">
            <AuthorName pubkey={note.pubkey} />
            {variant === "focused"
              ? null
              : (
                <Link class="note-card__time" to={href}>
                  <Timestamp createdAt={note.created_at} />
                </Link>
              )}
          </header>
          <div class="note-card__content">
            <NoteContent
              content={note.content}
              noMedia={variant === "compact"}
            />
          </div>
          {variant === "focused" && (
            <div class="note-card__fulltime">
              <Timestamp createdAt={note.created_at} full />
            </div>
          )}
          {showActions && (
            <footer class="note-card__actions">
              <IconButton
                label="Reply"
                size="sm"
                icon={<MessageCircle size={18} />}
                count={count(props.replyCount)}
                onClick={props.onReply}
                disabled={!props.onReply}
              />
              <IconButton
                label="Repost"
                size="sm"
                icon={<Repeat2 size={19} />}
                count={count(props.repostCount)}
                active={props.reposted}
                onClick={props.onRepost}
                disabled={!props.onRepost}
              />
              <IconButton
                label="Like"
                size="sm"
                icon={
                  <Heart
                    size={18}
                    fill={props.liked ? "currentColor" : "none"}
                  />
                }
                count={count(props.likeCount)}
                active={props.liked}
                onClick={props.onLike}
                disabled={!props.onLike}
              />
            </footer>
          )}
        </div>
      </div>
    </article>
  );
}
