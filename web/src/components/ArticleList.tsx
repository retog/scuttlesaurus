/**
 * A paged list of articles: loads the first page when `resetKey` changes,
 * then "Load more" pages through the list by publish time. Shows skeletons
 * while loading and a compact error with retry.
 *
 * Used by the Reads view and, with the author restriction, by the Profile view.
 *
 * @module
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ArticleRow } from "../lib/articles.ts";
import { explainError } from "../lib/articles.ts";
import { Button } from "./Button.tsx";
import { ArticleCard, type ArticleSummary } from "./ArticleCard.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Skeleton } from "./Spinner.tsx";

/** Props of {@link ArticleList}. */
export interface ArticleListProps {
  /**
   * Loads one page. `until` is undefined for the first page, otherwise the
   * `publishedAt` of the last article shown: fetch the articles published
   * before it. Must resolve with at most `limit` rows.
   */
  loadPage: (until: number | undefined, limit: number) => Promise<ArticleRow[]>;
  /** When this value changes, the list is emptied and the first page loaded again. */
  resetKey: string;
  /** Shown when the first page is empty. */
  empty: {
    title: string;
    text?: ComponentChildren;
    action?: ComponentChildren;
  };
  /** Articles per page (default 10). */
  pageSize?: number;
}

/** The card data of an article row. */
function toSummary(row: ArticleRow): ArticleSummary {
  return {
    naddr: row.naddr,
    title: row.title,
    summary: row.summary,
    image: row.image,
    pubkey: row.pubkey,
    publishedAt: row.publishedAt,
    content: row.content,
  };
}

/** A list of article cards with paging. */
export function ArticleList(
  { loadPage, resetKey, empty, pageSize = 10 }: ArticleListProps,
) {
  const [items, setItems] = useState<ArticleRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [more, setMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loader = useRef(loadPage);
  loader.current = loadPage;
  const generation = useRef(0);

  useEffect(() => {
    const id = ++generation.current;
    setState("loading");
    setItems([]);
    setError(undefined);
    loader.current(undefined, pageSize).then(
      (rows) => {
        if (id !== generation.current) return;
        setItems(rows);
        setMore(rows.length === pageSize);
        setState("ready");
      },
      (reason: unknown) => {
        if (id !== generation.current) return;
        setError(explainError(reason));
        setState("error");
      },
    );
  }, [resetKey, attempt, pageSize]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last || paging) return;
    const id = generation.current;
    setPaging(true);
    setError(undefined);
    try {
      const rows = await loader.current(last.publishedAt, pageSize);
      if (id !== generation.current) return;
      setItems((current) => {
        const known = new Set(current.map((row) => row.naddr));
        return [...current, ...rows.filter((row) => !known.has(row.naddr))];
      });
      setMore(rows.length === pageSize);
    } catch (reason) {
      if (id === generation.current) setError(explainError(reason));
    } finally {
      setPaging(false);
    }
  };

  if (state === "loading") {
    return <Skeleton shape="article" count={3} />;
  }
  if (state === "error") {
    return (
      <div class="article-list__error" role="alert">
        <p>Could not load articles. {error}</p>
        <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState title={empty.title} action={empty.action}>
        {empty.text}
      </EmptyState>
    );
  }
  return (
    <div class="article-list">
      <div class="stack">
        {items.map((row) => (
          <ArticleCard key={row.naddr} article={toSummary(row)} />
        ))}
      </div>
      {error && (
        <p class="article-list__error" role="alert">
          Could not load more. {error}
        </p>
      )}
      {more && (
        <div class="article-list__more">
          <Button loading={paging} onClick={loadMore}>Load more</Button>
        </div>
      )}
    </div>
  );
}
