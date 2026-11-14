/**
 * The comments of an article: a composer for a new top-level comment, then the
 * thread (two levels of indent; deeper replies are flattened, with the
 * author they answer). Replies and deletions of one's own comments.
 *
 * @module
 */
import { CornerDownRight } from "lucide-preact";
import { useMemo, useState } from "preact/hooks";
import {
  type ArticleRef,
  COMMENT_KIND,
  commentOnArticle,
  type CommentRow,
  deleteEvent,
  explainError,
  threadComments,
} from "../lib/articles.ts";
import { formatCount } from "../lib/format.ts";
import { Avatar } from "./Avatar.tsx";
import { AuthorName } from "./AuthorName.tsx";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { Composer } from "./Composer.tsx";
import { Button } from "./Button.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { session } from "../lib/session.ts";

/** Props of {@link CommentThread}. */
export interface CommentThreadProps {
  /** The article the comments belong to. */
  article: ArticleRef;
  /** Its comments, oldest first (as {@link fetchComments} returns them). */
  comments: CommentRow[];
  /** Called after a comment was posted or deleted, so the caller can reload. */
  onChanged: () => void;
}

/** Composer and thread of the comments on one article. */
export function CommentThread(
  { article, comments, onChanged }: CommentThreadProps,
) {
  const me = session.value?.pubkey;
  const items = useMemo(() => threadComments(comments), [comments]);
  const [replying, setReplying] = useState<string>();

  const post = async (content: string, parent?: CommentRow) => {
    try {
      await commentOnArticle(article, content, parent);
    } catch (reason) {
      throw new Error(explainError(reason));
    }
    setReplying(undefined);
    onChanged();
  };

  return (
    <div class="comments__body">
      <Composer
        placeholder="Add a comment"
        submitLabel="Comment"
        onSubmit={(content) => post(content)}
      />
      {items.length > 0 && (
        <ol class="thread" aria-label="Comments">
          {items.map(({ comment, depth, replyingTo }) => (
            <li
              key={comment.id}
              class={`thread__item thread__item--${depth}`}
            >
              <article class="comment">
                <div class="comment__head">
                  <Avatar pubkey={comment.pubkey} size={32} />
                  <div class="comment__who">
                    <AuthorName pubkey={comment.pubkey} showNip05={false} />
                    <Timestamp createdAt={comment.createdAt} />
                  </div>
                </div>
                {replyingTo && (
                  <p class="comment__to">
                    <CornerDownRight size={14} aria-hidden="true" />
                    replying to{" "}
                    <AuthorName
                      pubkey={replyingTo}
                      showNip05={false}
                      showHops={false}
                      plain
                    />
                  </p>
                )}
                {comment.content && (
                  <p class="comment__text">{comment.content}</p>
                )}
                <div class="comment__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setReplying(
                        replying === comment.id ? undefined : comment.id,
                      )}
                  >
                    {replying === comment.id ? "Close" : "Reply"}
                  </Button>
                  {me === comment.pubkey && (
                    <ConfirmButton
                      label="Delete"
                      question="Delete your comment?"
                      onConfirm={async () => {
                        await deleteEvent(comment.id, COMMENT_KIND);
                        onChanged();
                      }}
                    />
                  )}
                </div>
                {replying === comment.id && (
                  <div class="comment__reply">
                    <Composer
                      autoFocus
                      placeholder="Write a reply"
                      submitLabel="Reply"
                      onCancel={() => setReplying(undefined)}
                      onSubmit={(content) => post(content, comment)}
                    />
                  </div>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Heading text for a comment count: "No comments", "1 comment", "12 comments". */
export function commentsHeading(count: number): string {
  if (count === 0) return "No comments yet";
  return `${formatCount(count)} comment${count === 1 ? "" : "s"}`;
}
