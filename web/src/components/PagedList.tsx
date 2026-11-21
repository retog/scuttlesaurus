/**
 * A list that loads page after page from a cursor-based loader: the next page
 * is requested when a sentinel scrolls into view (with a "Load more" button as
 * the fallback), with skeletons while loading and a retryable error. It knows
 * nothing about notes; {@link NoteFeed} and the notifications use it.
 *
 * @module
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "./Button.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Skeleton } from "./Spinner.tsx";

/** Props of {@link PagedList}. */
export interface PagedListProps<T> {
  /**
   * Load a page. Called without a cursor for the first page, then with
   * `cursor(lastRow)` of the last row received. A page shorter than
   * `pageSize` ends the list; the cursor is inclusive, so rows already shown
   * are dropped by key.
   */
  load: (cursor?: number) => Promise<T[]>;
  /** Changing this empties the list and loads the first page again. */
  resetKey: string | number;
  /** Rows per page the loader returns when there are more (default 20). */
  pageSize?: number;
  /** Unique key of a row. */
  keyOf: (row: T) => string;
  /** The cursor a row stands for (what `load` gets as its argument). */
  cursorOf: (row: T) => number;
  /** Render one row. */
  render: (row: T) => ComponentChildren;
  /** Shown when the first page is empty. */
  empty: ComponentChildren;
  /** Rows to show above the loaded ones (new posts); duplicates are dropped. */
  prepend?: readonly T[];
  /** Rows to leave out (deleted notes). */
  hidden?: (row: T) => boolean;
  /** Called with the new rows of every page, after the state is updated. */
  onPage?: (rows: T[]) => void;
  /** Shape of the loading skeletons (default `note`). */
  skeleton?: "note" | "line";
  /** CSS class of the list element. */
  class?: string;
}

interface State<T> {
  rows: T[];
  end: boolean;
  loading: boolean;
  error?: string;
  started: boolean;
}

/** A paged list; see {@link PagedListProps}. */
export function PagedList<T>(props: PagedListProps<T>) {
  const { pageSize = 20, resetKey } = props;
  const [state, setState] = useState<State<T>>({
    rows: [],
    end: false,
    loading: true,
    started: false,
  });
  const latest = useRef(props);
  latest.current = props;
  const rows = useRef<T[]>([]);
  const generation = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const run = async (reset: boolean) => {
    const mine = reset ? ++generation.current : generation.current;
    const { load, keyOf, cursorOf, onPage } = latest.current;
    if (reset) rows.current = [];
    const last = rows.current.at(-1);
    const cursor = last === undefined ? undefined : cursorOf(last);
    setState((s) => ({
      rows: reset ? [] : s.rows,
      end: reset ? false : s.end,
      loading: true,
      started: reset ? false : s.started,
    }));
    try {
      const page = await load(cursor);
      if (mine !== generation.current) return;
      const seen = new Set(rows.current.map(keyOf));
      const fresh = page.filter((row) => {
        const key = keyOf(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      rows.current = [...rows.current, ...fresh];
      setState({
        rows: rows.current,
        end: page.length < pageSize || fresh.length === 0,
        loading: false,
        started: true,
      });
      onPage?.(fresh);
    } catch (error) {
      if (mine !== generation.current) return;
      setState((s) => ({
        ...s,
        loading: false,
        started: true,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  useEffect(() => {
    void run(true);
    return () => {
      generation.current++;
    };
  }, [resetKey]);

  const more = !state.end && !state.loading && !state.error &&
    state.rows.length > 0;
  useEffect(() => {
    const el = sentinel.current;
    if (!more || !el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void run(false);
    }, { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [more, state.rows.length]);

  const { prepend = [], hidden, keyOf, render } = props;
  const have = new Set(state.rows.map(keyOf));
  const shown = [
    ...prepend.filter((row) => !have.has(keyOf(row))),
    ...state.rows,
  ].filter((row) => !hidden?.(row));
  const skeleton = props.skeleton ?? "note";

  if (state.error && state.rows.length === 0 && prepend.length === 0) {
    return (
      <EmptyState
        tone="error"
        title="Could not load this"
        action={
          <Button variant="secondary" onClick={() => void run(true)}>
            Try again
          </Button>
        }
      >
        {state.error}
      </EmptyState>
    );
  }
  if (!state.started && shown.length === 0) {
    return <Skeleton shape={skeleton} count={4} />;
  }
  if (state.started && shown.length === 0 && !state.error) {
    return <>{props.empty}</>;
  }
  return (
    <div class="paged-list">
      <div class={`stack ${props.class ?? ""}`}>
        {shown.map((row) => <div key={keyOf(row)}>{render(row)}</div>)}
      </div>
      {state.loading && <Skeleton shape={skeleton} count={2} />}
      {state.error && (
        <div class="paged-list__error" role="alert">
          <span>{state.error}</span>
          <Button size="sm" onClick={() => void run(false)}>Retry</Button>
        </div>
      )}
      {more && (
        <div class="paged-list__more" ref={sentinel}>
          <Button variant="secondary" onClick={() => void run(false)}>
            Load more
          </Button>
        </div>
      )}
      {state.end && state.rows.length > 0 && (
        <p class="paged-list__end muted">That is everything for now.</p>
      )}
    </div>
  );
}
