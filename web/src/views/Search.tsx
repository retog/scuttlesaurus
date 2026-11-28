/**
 * Search: people, notes and articles. The query is kept in the URL
 * (`/search?q=…&tab=…`). A query that is an npub, nprofile or hex key always
 * finds that person first; one starting with `#` is a hashtag lookup.
 * Without a query: popular hashtags and people near you.
 *
 * @module
 */
import { Hash, Search as SearchIcon, SearchX, X } from "lucide-preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { ArticleCard } from "../components/ArticleCard.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { NoteFeed } from "../components/NoteFeed.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { PersonRow } from "../components/PersonRow.tsx";
import { Skeleton } from "../components/Spinner.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { viewerKey } from "../lib/actions.ts";
import {
  fetchNotes,
  fetchPeopleNearYou,
  fetchPopularTags,
  searchArticles,
  searchNotes,
  searchPeople,
} from "../lib/feed.ts";
import { useAsync, useDebounced, useDocumentTitle } from "../lib/hooks.ts";
import { parseEventId, parsePubkey } from "../lib/nostr.ts";
import { Link, navigate, useRoute } from "../lib/router.tsx";

type Tab = "people" | "notes" | "articles";

const TABS = [
  { value: "people", label: "People" },
  { value: "notes", label: "Notes" },
  { value: "articles", label: "Articles" },
] as const;

function searchPath(q: string, tab: Tab): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tab !== "people") params.set("tab", tab);
  const text = params.toString();
  return text ? `/search?${text}` : "/search";
}

function Suggestions() {
  const viewer = viewerKey.value;
  const tags = useAsync(() => fetchPopularTags(), []);
  const near = useAsync(
    () => viewer ? fetchPeopleNearYou(viewer) : Promise.resolve([]),
    [viewer],
  );
  return (
    <div class="search-suggest">
      <section aria-labelledby="sg-tags">
        <h2 class="search-suggest__title" id="sg-tags">Popular lately</h2>
        {tags.loading && !tags.data
          ? <Skeleton shape="line" count={2} />
          : tags.data?.length
          ? (
            <ul class="search-suggest__tags">
              {tags.data.map((t) => (
                <li key={t.tag}>
                  <Link class="chip" to={searchPath(`#${t.tag}`, "notes")}>
                    <Hash size={14} aria-hidden="true" />
                    {t.tag}
                    <span class="chip__count">{t.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )
          : <p class="muted">No hashtags in use recently.</p>}
      </section>
      <section aria-labelledby="sg-people">
        <h2 class="search-suggest__title" id="sg-people">People near you</h2>
        {near.loading && !near.data
          ? <Skeleton shape="note" count={2} />
          : near.data?.length
          ? (
            <div class="stack">
              {near.data.map((p) => (
                <PersonRow key={p.pubkey} pubkey={p.pubkey} via={p.via} />
              ))}
            </div>
          )
          : (
            <p class="muted">
              Nobody yet: this lists people followed by several of the people
              you follow.
            </p>
          )}
      </section>
    </div>
  );
}

function People({ q }: { q: string }) {
  const direct = useMemo(() => parsePubkey(q), [q]);
  const { data, error, loading, reload } = useAsync(
    () => searchPeople(q),
    [q],
  );
  if (loading && !data) return <Skeleton shape="note" count={3} />;
  if (error && !data) {
    return (
      <EmptyState tone="error" title="Search failed">
        {error.message}
      </EmptyState>
    );
  }
  const found = data ?? [];
  const list = [
    ...(direct ? [direct] : []),
    ...found.map((p) => p.pubkey).filter((k) => k !== direct),
  ];
  if (list.length === 0) {
    return (
      <EmptyState
        title="No people found"
        icon={<SearchX size={36} />}
        action={
          <button type="button" class="link-button" onClick={reload}>
            Search again
          </button>
        }
      >
        Nobody in this node knows a name, display name or NIP-05 like “{q}”. You
        can also paste an npub.
      </EmptyState>
    );
  }
  return (
    <div class="stack">
      {list.map((pubkey) => (
        <PersonRow
          key={pubkey}
          pubkey={pubkey}
          flagUnknown={pubkey === direct}
        />
      ))}
    </div>
  );
}

function Notes({ q }: { q: string }) {
  const id = useMemo(() => q.startsWith("#") ? null : parseEventId(q), [q]);
  return (
    <NoteFeed
      resetKey={q}
      load={(until) =>
        id
          ? until === undefined ? fetchNotes([id]) : Promise.resolve([])
          : searchNotes(q, { until })}
      readAloudTitle={`Search · ${q}`}
      empty={
        <EmptyState title="No notes found" icon={<SearchX size={36} />}>
          {q.startsWith("#")
            ? `No note in this node is tagged ${q}.`
            : `No note in this node contains “${q}”. Start with # to look up a hashtag.`}
        </EmptyState>
      }
    />
  );
}

function Articles({ q }: { q: string }) {
  const { data, error, loading } = useAsync(() => searchArticles(q), [q]);
  if (loading && !data) return <Skeleton shape="article" count={2} />;
  if (error && !data) {
    return (
      <EmptyState tone="error" title="Search failed">
        {error.message}
      </EmptyState>
    );
  }
  if (!data?.length) {
    return (
      <EmptyState title="No articles found" icon={<SearchX size={36} />}>
        No long-form article has “{q}” in its title, summary or text.
      </EmptyState>
    );
  }
  return (
    <div class="stack">
      {data.map((a) => (
        <ArticleCard key={a.naddr} article={a} variant="compact" />
      ))}
    </div>
  );
}

/** The Search view. */
export default function SearchView() {
  const { query } = useRoute();
  const q = (query.get("q") ?? "").trim();
  const tab: Tab = TABS.some((t) => t.value === query.get("tab"))
    ? query.get("tab") as Tab
    : "people";
  useDocumentTitle(q ? `Search: ${q}` : "Search");

  const [text, setText] = useState(q);
  const debounced = useDebounced(text.trim(), 300);

  // The field follows the URL when it changes from outside (a hashtag link).
  useEffect(() => {
    setText((current) => current.trim() === q ? current : q);
  }, [q]);
  // The URL follows the field.
  useEffect(() => {
    if (debounced !== q) {
      navigate(searchPath(debounced, tab), { replace: true });
    }
  }, [debounced]);

  return (
    <div class="page search">
      <PageHeader title="Search" />
      <form
        class="search-field"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(searchPath(text.trim(), tab), { replace: true });
        }}
      >
        <SearchIcon size={18} aria-hidden="true" />
        <input
          class="search-field__input"
          type="search"
          value={text}
          placeholder="Names, words, #hashtags, npub…"
          aria-label="Search"
          autoComplete="off"
          autoCapitalize="off"
          spellcheck={false}
          autofocus={!q}
          onInput={(event) => setText((event.target as HTMLInputElement).value)}
        />
        {text && (
          <button
            type="button"
            class="search-field__clear"
            aria-label="Clear search"
            onClick={() => {
              setText("");
              navigate(searchPath("", tab), { replace: true });
            }}
          >
            <X size={16} />
          </button>
        )}
      </form>
      {q
        ? (
          <>
            <Tabs<Tab>
              label="What to search"
              tabs={TABS}
              value={tab}
              onChange={(next) =>
                navigate(searchPath(q, next), { replace: true })}
            />
            <div role="tabpanel">
              {tab === "people" && <People q={q} />}
              {tab === "notes" && <Notes q={q} />}
              {tab === "articles" && <Articles q={q} />}
            </div>
          </>
        )
        : <Suggestions />}
    </div>
  );
}
