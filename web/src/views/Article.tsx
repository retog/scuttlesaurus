/**
 * The article reader: cover, title and standfirst, byline, the body in the
 * reading typeface, actions (like, copy link, edit and delete for the
 * author), then the comments.
 *
 * @module
 */
import { Heart, Link as LinkIcon, Pencil } from "lucide-preact";
import { useState } from "preact/hooks";
import { AuthorName } from "../components/AuthorName.tsx";
import { Avatar } from "../components/Avatar.tsx";
import { Button, IconButton } from "../components/Button.tsx";
import {
  commentsHeading,
  CommentThread,
} from "../components/CommentThread.tsx";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ReadAloudButton } from "../components/ReadAloud.tsx";
import { Skeleton } from "../components/Spinner.tsx";
import { toast } from "../components/Toast.tsx";
import {
  bodyWithoutTitle,
  deleteAddress,
  explainError,
  fetchArticle,
  fetchArticleReactions,
  fetchComments,
  likeArticle,
  unlike,
} from "../lib/articles.ts";
import { dateOnly, readingTime } from "../lib/format.ts";
import { useAsync, useDocumentTitle } from "../lib/hooks.ts";
import { status } from "../lib/node.ts";
import { articlePath, decodeNip19 } from "../lib/nostr.ts";
import { Link, navigate, useRoute } from "../lib/router.tsx";
import { canSign, session } from "../lib/session.ts";
import { openLogin } from "../lib/ui.ts";
import { articleItem } from "../lib/read_aloud.ts";
import { playItem } from "../lib/speech.ts";

/** The reader of one article, addressed by `/a/:naddr`. */
export default function ArticleView() {
  const { params } = useRoute();
  const naddr = params.naddr ?? "";
  const me = session.value?.pubkey;
  const article = useAsync(() => fetchArticle(naddr), [naddr]);
  const data = article.data;
  useDocumentTitle(data?.title);
  const comments = useAsync(() => fetchComments(naddr), [naddr]);
  const reactions = useAsync(
    async () => {
      if (!data) return undefined;
      const map = await fetchArticleReactions([data.versionId], me);
      return map.get(data.versionId) ?? { count: 0 };
    },
    [data?.versionId, me],
  );
  const [liking, setLiking] = useState(false);

  if (article.error) {
    return (
      <div class="page">
        <EmptyState
          tone="error"
          title="This article could not be loaded"
          action={<Button size="sm" onClick={article.reload}>Try again</Button>}
        >
          {explainError(article.error)}
        </EmptyState>
      </div>
    );
  }
  if (!data) {
    if (article.loading) {
      return (
        <div class="page article-loading" aria-busy="true">
          <Skeleton shape="line" count={4} />
        </div>
      );
    }
    const hops = status.value?.hops;
    return (
      <div class="page">
        <EmptyState title="This article is outside your habitat">
          Only writing from people within {hops ?? "a few"} hops is kept
          {decodeNip19(naddr)?.type === "naddr"
            ? ", and this article has been deleted or was never published here."
            : "."}
        </EmptyState>
      </div>
    );
  }

  const own = reactions.data?.own;
  const liked = own !== undefined;
  const count = reactions.data?.count ?? 0;
  const mine = me === data.pubkey;
  const updated = data.versionCount > 1;
  const commentCount = comments.data?.length ?? 0;

  const toggleLike = async () => {
    if (!canSign.value) {
      openLogin();
      return;
    }
    setLiking(true);
    try {
      if (own) await unlike(own);
      else await likeArticle(data);
      reactions.reload();
    } catch (reason) {
      toast(explainError(reason), "error");
    } finally {
      setLiking(false);
    }
  };

  const copyLink = async () => {
    const url = new URL(articlePath(data.naddr), globalThis.location.origin)
      .href;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied", "success");
    } catch {
      toast(url, "info");
    }
  };

  return (
    <div class="page">
      <article class="article" aria-labelledby="article-title">
        {data.image && (
          <figure class="article__cover">
            <img src={data.image} alt="" decoding="async" />
          </figure>
        )}
        <header class="article__header">
          <h1 id="article-title" class="article__title">{data.title}</h1>
          {data.summary && <p class="article__standfirst">{data.summary}</p>}
          <div class="article__byline">
            <Avatar pubkey={data.pubkey} size={44} />
            <div class="article__byline-text">
              <AuthorName pubkey={data.pubkey} />
              <p class="article__meta">
                <time
                  dateTime={new Date(data.publishedAt * 1000).toISOString()}
                >
                  {dateOnly(data.publishedAt)}
                </time>
                <span aria-hidden="true">·</span>
                <span>{readingTime(data.content)}</span>
                {updated && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Updated {dateOnly(data.createdAt)}</span>
                  </>
                )}
              </p>
            </div>
          </div>
          {data.tags.length > 0 && (
            <ul class="article__topics" aria-label="Topics">
              {data.tags.map((topic) => (
                <li key={topic}>
                  <Link
                    class="topic-chip-link"
                    to={`/reads?tag=${encodeURIComponent(topic)}`}
                  >
                    #{topic}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </header>

        <Markdown
          source={bodyWithoutTitle(data.content, data.title)}
          class="article__body"
        />

        <footer class="article__actions">
          <IconButton
            label={liked ? "Unlike" : "Like"}
            active={liked}
            disabled={liking}
            count={count}
            icon={
              <Heart
                size={18}
                fill={liked ? "currentColor" : "none"}
                aria-hidden="true"
              />
            }
            onClick={toggleLike}
          />
          <ReadAloudButton
            look="icon"
            label="Listen to this article"
            onStart={() => playItem("Article", () => articleItem(data))}
          />
          <IconButton
            label="Copy link"
            icon={<LinkIcon size={18} aria-hidden="true" />}
            onClick={copyLink}
          />
          {mine && (
            <span class="article__owner">
              <Button
                variant="secondary"
                size="sm"
                to={`/write/${data.naddr}`}
                icon={<Pencil size={15} aria-hidden="true" />}
              >
                Edit
              </Button>
              <ConfirmButton
                label="Delete"
                question="Delete this article? It disappears for everybody."
                onConfirm={async () => {
                  await deleteAddress(data);
                  toast("Article deleted", "success");
                  navigate("/reads");
                }}
              />
            </span>
          )}
        </footer>
      </article>

      <section class="comments" aria-labelledby="comments-title">
        <h2 id="comments-title" class="comments__title">
          {commentsHeading(commentCount)}
        </h2>
        <CommentThread
          article={data}
          comments={comments.data ?? []}
          onChanged={comments.reload}
        />
      </section>
    </div>
  );
}
