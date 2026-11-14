/**
 * A long-form article (kind 30023) as a card with cover, title and summary.
 *
 * @module
 */
import { dateOnly, readingTime } from "../lib/format.ts";
import { articlePath } from "../lib/nostr.ts";
import { Link, navigate } from "../lib/router.tsx";
import { Avatar } from "./Avatar.tsx";
import { AuthorName } from "./AuthorName.tsx";

/** What the card shows of an article. */
export interface ArticleSummary {
  /** `naddr1…` of the article (without relay hints). */
  naddr: string;
  title: string;
  summary?: string;
  /** Cover image URL. */
  image?: string;
  pubkey: string;
  /** Unix seconds (`published_at`, or `created_at` as a fallback). */
  publishedAt: number;
  /** Markdown body, only used to estimate reading time. */
  content?: string;
}

/** Props of {@link ArticleCard}. */
export interface ArticleCardProps {
  article: ArticleSummary;
  /** `compact` drops the cover and the summary. */
  variant?: "default" | "compact";
}

/** Card for an article in a list. */
export function ArticleCard(
  { article, variant = "default" }: ArticleCardProps,
) {
  const href = articlePath(article.naddr);
  const open = (event: MouseEvent) => {
    if ((event.target as Element).closest("a, button")) return;
    navigate(href);
  };
  return (
    <article
      class={`card article-card article-card--${variant}`}
      onClick={open}
    >
      {variant === "default" && article.image && (
        <Link
          class="article-card__cover"
          to={href}
          tabIndex={-1}
          aria-hidden="true"
        >
          <img src={article.image} alt="" loading="lazy" decoding="async" />
        </Link>
      )}
      <div class="article-card__body">
        <h2 class="article-card__title">
          <Link to={href}>{article.title}</Link>
        </h2>
        {variant === "default" && article.summary && (
          <p class="article-card__summary">{article.summary}</p>
        )}
        <footer class="article-card__meta">
          <Avatar pubkey={article.pubkey} size={24} />
          <AuthorName pubkey={article.pubkey} showNip05={false} />
          <span class="article-card__dot" aria-hidden="true">·</span>
          <span>{dateOnly(article.publishedAt)}</span>
          {article.content && (
            <>
              <span class="article-card__dot" aria-hidden="true">·</span>
              <span>{readingTime(article.content)}</span>
            </>
          )}
        </footer>
      </div>
    </article>
  );
}
